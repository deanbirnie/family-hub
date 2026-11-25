package dev.familyhub.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.BatteryManager;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * An SOS under way (phase 10b): a foreground service that takes the phone's
 * location every 2 minutes (every 5 when the battery is low) and sends it to
 * the hub, with the screen off and the app locked.
 *
 * <p>It sends with the pass the hub gave for this SOS only (no session).
 * Locations that cannot be sent (no signal) are kept in the app's private
 * storage and go up together in one request when the connection is back: a
 * clean retry, never a burst. It stops when the SOS is ended, or when the hub
 * says it has ended.
 */
public class SosService extends Service {

  static final String CHANNEL = "family-hub-sos";
  private static final int NOTIFICATION = 7001;
  private static final long EVERY_MS = 2 * 60_000L;
  private static final long EVERY_LOW_MS = 5 * 60_000L;
  private static final int BATCH = 100;

  // What the plugin reads (same process).
  static volatile boolean running;
  static volatile String server;
  static volatile String sosId;
  static volatile String pass;
  static volatile long lastSentAt;
  static volatile long lastFixAt;
  static volatile int waiting;

  private final List<JSONObject> queue = new ArrayList<>();
  private final ExecutorService net = Executors.newSingleThreadExecutor();
  private final AtomicBoolean sending = new AtomicBoolean(false);
  private LocationManager lm;
  private LocationListener listener;
  private boolean low;
  private ConnectivityManager.NetworkCallback netCallback;

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && intent.getStringExtra("id") != null) {
      server = intent.getStringExtra("server");
      sosId = intent.getStringExtra("id");
      pass = intent.getStringExtra("pass");
    }
    if (sosId == null) {
      stopSelf();
      return START_NOT_STICKY;
    }
    showNotification();
    running = true;
    loadQueue();
    watchLocation(true);
    watchNetwork();
    return START_REDELIVER_INTENT;
  }

  private void showNotification() {
    NotificationManager nm = getSystemService(NotificationManager.class);
    NotificationChannel channel = new NotificationChannel(CHANNEL, "SOS", NotificationManager.IMPORTANCE_HIGH);
    channel.setSound(null, null);
    channel.enableVibration(false);
    nm.createNotificationChannel(channel);
    Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    Notification n =
        new Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_family_hub)
            .setContentTitle("SOS is on")
            .setContentText("Your location is being sent to the family. Tap to end it.")
            .setOngoing(true)
            .setContentIntent(tap)
            .build();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
    else startForeground(NOTIFICATION, n);
  }

  private boolean batteryLow() {
    BatteryManager bm = getSystemService(BatteryManager.class);
    PowerManager pm = getSystemService(PowerManager.class);
    int level = bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) : 100;
    return (level > 0 && level <= 20) || (pm != null && pm.isPowerSaveMode());
  }

  @SuppressWarnings("MissingPermission")
  private void watchLocation(boolean first) {
    lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
    if (lm == null) return;
    if (listener != null) lm.removeUpdates(listener);
    low = batteryLow();
    String provider =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && lm.hasProvider(LocationManager.FUSED_PROVIDER)
            ? LocationManager.FUSED_PROVIDER
            : (lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ? LocationManager.GPS_PROVIDER : LocationManager.NETWORK_PROVIDER);
    listener = this::onLocation;
    try {
      lm.requestLocationUpdates(provider, low ? EVERY_LOW_MS : EVERY_MS, 0f, listener, Looper.getMainLooper());
      // The first one at once, not in two minutes.
      if (first) lm.getCurrentLocation(provider, null, getMainExecutor(), l -> { if (l != null) onLocation(l); });
    } catch (SecurityException e) {
      // Location was taken away while the SOS was on: keep the service (and what is waiting) for when it is back.
    }
  }

  private void onLocation(Location l) {
    try {
      JSONObject p = new JSONObject();
      p.put("latitude", l.getLatitude());
      p.put("longitude", l.getLongitude());
      if (l.hasAccuracy()) p.put("accuracy", (double) l.getAccuracy());
      p.put("at", l.getTime());
      boolean nowLow = batteryLow();
      p.put("batteryLow", nowLow);
      synchronized (queue) {
        queue.add(p);
        saveQueue();
      }
      lastFixAt = System.currentTimeMillis();
      if (nowLow != low) watchLocation(false);
    } catch (Exception e) {
      // A location that cannot be written is skipped; the next one comes soon.
    }
    flush();
  }

  private void watchNetwork() {
    if (netCallback != null) return;
    ConnectivityManager cm = getSystemService(ConnectivityManager.class);
    if (cm == null) return;
    netCallback =
        new ConnectivityManager.NetworkCallback() {
          @Override
          public void onAvailable(Network network) {
            flush();
          }
        };
    cm.registerDefaultNetworkCallback(netCallback);
  }

  /** Sends what is waiting, in one request; on failure it stays for the next location or the next connection. */
  void flush() {
    if (!sending.compareAndSet(false, true)) return;
    net.execute(
        () -> {
          try {
            JSONArray points = new JSONArray();
            int count;
            synchronized (queue) {
              count = Math.min(queue.size(), BATCH);
              for (int i = 0; i < count; i++) points.put(queue.get(i));
            }
            if (count == 0) return;
            JSONObject body = new JSONObject();
            body.put("pass", pass);
            body.put("points", points);
            int status = post(server, "/api/safety/sos/" + sosId + "/points", body);
            if (status >= 200 && status < 300) {
              synchronized (queue) {
                queue.subList(0, Math.min(count, queue.size())).clear();
                saveQueue();
              }
              lastSentAt = System.currentTimeMillis();
            } else if (status == 404 || status == 410) {
              // Ended (from another phone, or by the hub): stop.
              finish();
            }
          } catch (Exception e) {
            // No signal: try again with the next location, or when the connection is back.
          } finally {
            waiting = queueSize();
            sending.set(false);
          }
        });
  }

  /** Posts JSON to the hub; the status code, or an exception with no connection. */
  static int post(String server, String path, JSONObject body) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(server.replaceAll("/+$", "") + path).openConnection();
    c.setConnectTimeout(20_000);
    c.setReadTimeout(30_000);
    c.setRequestMethod("POST");
    c.setDoOutput(true);
    c.setRequestProperty("Content-Type", "application/json");
    c.setRequestProperty("X-Requested-With", "family-hub");
    try (OutputStream out = c.getOutputStream()) {
      out.write(body.toString().getBytes(StandardCharsets.UTF_8));
    }
    int status = c.getResponseCode();
    c.disconnect();
    return status;
  }

  /** The locations not yet sent, for ending the SOS with them. */
  JSONArray waitingPoints() {
    JSONArray out = new JSONArray();
    synchronized (queue) {
      for (JSONObject p : queue) out.put(p);
    }
    return out;
  }

  private int queueSize() {
    synchronized (queue) {
      return queue.size();
    }
  }

  private File queueFile() {
    return new File(getFilesDir(), "sos-queue.json");
  }

  private void loadQueue() {
    synchronized (queue) {
      queue.clear();
      try {
        File f = queueFile();
        if (!f.exists()) return;
        JSONArray a = new JSONArray(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
        for (int i = 0; i < a.length(); i++) queue.add(a.getJSONObject(i));
      } catch (Exception e) {
        // A damaged file is dropped.
      }
    }
    waiting = queueSize();
  }

  private void saveQueue() {
    try (FileOutputStream out = new FileOutputStream(queueFile())) {
      JSONArray a = new JSONArray();
      for (JSONObject p : queue) a.put(p);
      out.write(a.toString().getBytes(StandardCharsets.UTF_8));
    } catch (Exception e) {
      // Kept in memory at least.
    }
    waiting = queue.size();
  }

  /** Ends the service and forgets what was waiting (the SOS is over). */
  void finish() {
    synchronized (queue) {
      queue.clear();
      queueFile().delete();
    }
    stopSelf();
  }

  static SosService instance;

  @Override
  public void onCreate() {
    super.onCreate();
    instance = this;
  }

  @Override
  public void onDestroy() {
    if (lm != null && listener != null) lm.removeUpdates(listener);
    ConnectivityManager cm = getSystemService(ConnectivityManager.class);
    if (cm != null && netCallback != null) cm.unregisterNetworkCallback(netCallback);
    running = false;
    sosId = null;
    pass = null;
    waiting = 0;
    instance = null;
    net.shutdown();
    super.onDestroy();
  }
}
