package dev.familyhub.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.BatteryManager;
import android.os.Build;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.telephony.SmsManager;
import java.io.InputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
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
 *
 * <p>Started from the lock screen (SosTileService, phase 10c), it first starts
 * the SOS itself, with the phone's SOS key. With no data for a minute, it
 * texts the latest location to the family's mobile numbers, then at most once
 * every 15 minutes while it stays offline.
 */
public class SosService extends Service {

  static final String CHANNEL = "family-hub-sos";
  private static final int NOTIFICATION = 7001;
  private static final long EVERY_MS = 2 * 60_000L;
  private static final long EVERY_LOW_MS = 5 * 60_000L;
  private static final int BATCH = 100;
  private static final long SMS_AFTER_MS = 60_000L;
  private static final long SMS_EVERY_MS = 15 * 60_000L;

  // What the plugin reads (same process).
  static volatile boolean running;
  static volatile String server;
  static volatile String sosId;
  static volatile String pass;
  static volatile long lastSentAt;
  static volatile long lastFixAt;
  static volatile int waiting;
  static volatile String deviceId;
  static volatile String name;
  static volatile long offlineSince;
  static volatile long lastSmsAt;
  private volatile JSONObject latest;
  private final Handler ticker = new Handler(Looper.getMainLooper());
  private final Runnable tick =
      new Runnable() {
        @Override
        public void run() {
          if (sosId == null) flush();
          maybeSms();
          ticker.postDelayed(this, 30_000L);
        }
      };

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
    if (intent != null && intent.getStringExtra("server") != null) {
      server = intent.getStringExtra("server");
      // From the app: the SOS is already started. From the lock screen: this service starts it with the SOS key.
      sosId = intent.getStringExtra("id");
      pass = intent.getStringExtra("pass");
      deviceId = intent.getStringExtra("deviceId");
      name = intent.getStringExtra("name");
    }
    if (server == null || (sosId == null && deviceId == null)) {
      stopSelf();
      return START_NOT_STICKY;
    }
    ticker.removeCallbacks(tick);
    ticker.postDelayed(tick, 30_000L);
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
      latest = p;
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
            if (sosId == null && !startWithKey()) return;
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
              offlineSince = 0;
            } else if (status == 404 || status == 410) {
              // Ended (from another phone, or by the hub): stop.
              finish();
            }
          } catch (Exception e) {
            // No signal: try again with the next location, or when the connection is back.
            if (offlineSince == 0) offlineSince = System.currentTimeMillis();
          } finally {
            waiting = queueSize();
            sending.set(false);
          }
        });
  }

  /** Starts the SOS with the phone's SOS key (from the lock screen): a one-time challenge, signed. */
  private boolean startWithKey() throws Exception {
    JSONObject c = postForJson("/api/devices/challenge", new JSONObject().put("deviceId", deviceId));
    if (c == null) return false;
    JSONObject body = new JSONObject();
    body.put("deviceId", deviceId);
    body.put("challengeId", c.getString("challengeId"));
    body.put("signature", SosVault.sign(c.getString("challenge"), deviceId));
    if (latest != null) body.put("location", latest);
    JSONObject started = postForJson("/api/safety/sos/by-key", body);
    if (started == null) return false;
    pass = started.getString("pass");
    sosId = started.getJSONObject("sos").getString("id");
    offlineSince = 0;
    lastSentAt = System.currentTimeMillis();
    return true;
  }

  /** Posts JSON and reads the JSON answer; null if the hub said no (throws with no connection). */
  private static JSONObject postForJson(String path, JSONObject body) throws Exception {
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
    if (status < 200 || status >= 300) {
      c.disconnect();
      return null;
    }
    try (InputStream in = c.getInputStream()) {
      // (InputStream.readAllBytes is only on Android 13 and later.)
      java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
      byte[] buf = new byte[4096];
      for (int n; (n = in.read(buf)) > 0; ) bytes.write(buf, 0, n);
      return new JSONObject(bytes.toString("UTF-8"));
    } finally {
      c.disconnect();
    }
  }

  /** With no data for a minute: the latest location by SMS to the family, at most every 15 minutes while offline. */
  private void maybeSms() {
    long now = System.currentTimeMillis();
    if (offlineSince == 0 || now - offlineSince < SMS_AFTER_MS || now - lastSmsAt < SMS_EVERY_MS) return;
    if (checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) return;
    JSONObject store = SosVault.read(this);
    org.json.JSONArray numbers = store.optJSONArray("numbers");
    if (numbers == null || numbers.length() == 0) return;
    String who = name != null ? name : store.optString("name", "Someone");
    JSONObject p = latest;
    String where =
        p == null
            ? "No location yet."
            : String.format(Locale.ROOT, "%.5f,%.5f https://www.google.com/maps/search/?api=1&query=%.5f,%.5f (%s)", p.optDouble("latitude"), p.optDouble("longitude"), p.optDouble("latitude"), p.optDouble("longitude"), new SimpleDateFormat("HH:mm", Locale.ROOT).format(new Date(p.optLong("at", now))));
    String text = "SOS from " + who + " (Family Hub, no data): " + where;
    SmsManager sms = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? getSystemService(SmsManager.class) : SmsManager.getDefault();
    if (sms == null) return;
    for (int i = 0; i < numbers.length(); i++) {
      String to = numbers.optJSONObject(i) != null ? numbers.optJSONObject(i).optString("phone", "") : "";
      if (to.isEmpty()) continue;
      try {
        sms.sendMultipartTextMessage(to, null, sms.divideMessage(text), null, null);
      } catch (Exception e) {
        // One number failing does not stop the others.
      }
    }
    lastSmsAt = now;
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
    ticker.removeCallbacks(tick);
    if (lm != null && listener != null) lm.removeUpdates(listener);
    ConnectivityManager cm = getSystemService(ConnectivityManager.class);
    if (cm != null && netCallback != null) cm.unregisterNetworkCallback(netCallback);
    running = false;
    sosId = null;
    pass = null;
    deviceId = null;
    offlineSince = 0;
    lastSmsAt = 0;
    waiting = 0;
    instance = null;
    net.shutdown();
    super.onDestroy();
  }
}
