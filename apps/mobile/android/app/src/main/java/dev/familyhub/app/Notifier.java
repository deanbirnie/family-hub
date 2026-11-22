package dev.familyhub.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Shows the hub's reminders as Android notifications, whichever way they
 * arrive: a UnifiedPush message (FamilyPushService) or the daily background
 * check (DailyCheckJob), which asks the hub directly and works without any
 * push service. Each reminder has a tag; one already shown is not shown again.
 *
 * <p>The text is always generic ("A family document expires soon"): the
 * details are only in the app, behind the fingerprint.
 */
final class Notifier {

  static final String PREFS = "family_hub_push";
  static final String SERVER_URL = "server_url";
  static final String CHECK_TOKEN = "check_token";
  static final String ENDPOINT_URL = "endpoint_url";
  static final String ENDPOINT_P256DH = "endpoint_p256dh";
  static final String ENDPOINT_AUTH = "endpoint_auth";
  static final String LAST_CHECK = "last_check";
  private static final String SHOWN = "shown_tags";
  private static final int MAX_SHOWN = 300;

  private static final String CHANNEL = "reminders";
  static final int JOB_ID = 4201;
  private static final long DAY_MS = 24L * 60 * 60 * 1000;
  private static final long FLEX_MS = 4L * 60 * 60 * 1000;

  private Notifier() {}

  static SharedPreferences prefs(Context context) {
    return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  static boolean allowed(Context context) {
    if (Build.VERSION.SDK_INT >= 33
        && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      return false;
    }
    return NotificationManagerCompat.from(context).areNotificationsEnabled();
  }

  private static void ensureChannel(Context context) {
    NotificationChannel channel = new NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_DEFAULT);
    channel.setDescription("Reminders from the family hub, such as a passport that expires soon.");
    channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
    context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
  }

  /** Shows one notification, unless one with this tag was shown before. Returns whether it was shown. */
  static synchronized boolean show(Context context, String tag, String title, String body) {
    if (tag == null || tag.isEmpty() || !allowed(context)) return false;
    SharedPreferences prefs = prefs(context);
    JSONArray shown;
    try {
      shown = new JSONArray(prefs.getString(SHOWN, "[]"));
    } catch (JSONException e) {
      shown = new JSONArray();
    }
    for (int i = 0; i < shown.length(); i++) {
      if (tag.equals(shown.optString(i))) return false;
    }
    ensureChannel(context);
    Intent open = new Intent(context, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    PendingIntent tap = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    android.app.Notification hidden =
        new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_family_hub)
            .setContentTitle("Family Hub")
            .setContentText("Open the app to see what is due.")
            .build();
    android.app.Notification notification =
        new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_family_hub)
            .setContentTitle(title == null || title.isEmpty() ? "Family Hub" : title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(hidden)
            .build();
    try {
      NotificationManagerCompat.from(context).notify(tag, 1, notification);
    } catch (SecurityException e) {
      return false;
    }
    // Remember it, keeping the list short.
    JSONArray next = new JSONArray();
    int start = Math.max(0, shown.length() - (MAX_SHOWN - 1));
    for (int i = start; i < shown.length(); i++) next.put(shown.optString(i));
    next.put(tag);
    prefs.edit().putString(SHOWN, next.toString()).apply();
    return true;
  }

  /** Shows a push message's JSON ({"title", "body", "tag"}). */
  static void showMessage(Context context, byte[] content) {
    try {
      JSONObject msg = new JSONObject(new String(content, StandardCharsets.UTF_8));
      String tag = msg.optString("tag", "");
      // Test notifications have a fresh tag each time.
      show(context, tag, msg.optString("title", "Family Hub"), msg.optString("body", "Something needs your attention."));
    } catch (JSONException ignored) {
      // Not from the hub: ignore.
    }
  }

  // ---- the daily check ------------------------------------------------------------------

  static void schedule(Context context) {
    JobInfo job =
        new JobInfo.Builder(JOB_ID, new ComponentName(context, DailyCheckJob.class))
            .setPeriodic(DAY_MS, FLEX_MS)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
            .build();
    context.getSystemService(JobScheduler.class).schedule(job);
  }

  static void cancel(Context context) {
    context.getSystemService(JobScheduler.class).cancel(JOB_ID);
  }

  /**
   * Asks the hub what is due and shows anything new. Returns how many were
   * shown. Runs off the main thread.
   */
  static int check(Context context) throws IOException {
    SharedPreferences prefs = prefs(context);
    String server = prefs.getString(SERVER_URL, "");
    String token = prefs.getString(CHECK_TOKEN, "");
    if (server.isEmpty() || token.isEmpty() || !server.startsWith("https://")) return 0;
    HttpURLConnection conn = (HttpURLConnection) new URL(server + "/api/notifications/due").openConnection();
    try {
      conn.setConnectTimeout(15_000);
      conn.setReadTimeout(15_000);
      conn.setInstanceFollowRedirects(false);
      conn.setRequestProperty("Authorization", "Check " + token);
      conn.setRequestProperty("Accept", "application/json");
      int status = conn.getResponseCode();
      if (status == 401) {
        // The phone was removed, or notifications were turned off elsewhere.
        prefs.edit().remove(CHECK_TOKEN).apply();
        cancel(context);
        return 0;
      }
      if (status != 200) throw new IOException("The hub answered " + status);
      JSONArray items = new JSONObject(read(conn.getInputStream())).optJSONArray("items");
      prefs.edit().putLong(LAST_CHECK, System.currentTimeMillis()).apply();
      int shown = 0;
      if (items == null) return 0;
      for (int i = 0; i < items.length(); i++) {
        JSONObject item = items.optJSONObject(i);
        if (item != null && show(context, item.optString("tag", ""), item.optString("title", "Family Hub"), item.optString("body", ""))) shown++;
      }
      return shown;
    } catch (JSONException e) {
      throw new IOException("The hub's answer could not be read", e);
    } finally {
      conn.disconnect();
    }
  }

  private static String read(InputStream in) throws IOException {
    try (InputStream stream = in) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buf = new byte[8192];
      int n;
      int total = 0;
      while ((n = stream.read(buf)) != -1) {
        total += n;
        if (total > 256 * 1024) throw new IOException("The hub's answer is too long");
        out.write(buf, 0, n);
      }
      return out.toString("UTF-8");
    }
  }
}
