package dev.familyhub.app;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.List;
import org.unifiedpush.android.connector.UnifiedPush;

/**
 * Notifications on the phone, for the shared interface (apps/mobile/src/push.ts):
 *
 * <ul>
 *   <li>the daily background check (DailyCheckJob), with a token from the hub that can only read
 *       this person's due reminders;
 *   <li>UnifiedPush, through the distributor installed on the phone (ntfy or another), for
 *       reminders as soon as they are sent. Optional: without a distributor the daily check still
 *       works.
 * </ul>
 */
@CapacitorPlugin(name = "Push", permissions = {@Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})})
public class PushPlugin extends Plugin {

  private static final String INSTANCE = "default";
  private static final String NTFY = "io.heckel.ntfy";
  private static final long REGISTER_TIMEOUT_MS = 30_000;

  /** The register() call waiting for the distributor's answer. */
  private static PluginCall pending;
  private static Context pendingContext;
  private static Runnable pendingTimeout;
  private static final Handler main = new Handler(Looper.getMainLooper());

  /** Called by FamilyPushService when the distributor answers a registration. */
  static void registrationDone(String endpoint, String problem) {
    main.post(
        () -> {
          PluginCall call = pending;
          pending = null;
          if (pendingTimeout != null) main.removeCallbacks(pendingTimeout);
          pendingTimeout = null;
          if (call == null) return;
          JSObject out = new JSObject();
          if (endpoint != null && pendingContext != null) out.put("endpoint", endpointObject(pendingContext));
          else out.put("problem", problem);
          call.resolve(out);
        });
  }

  private static JSObject endpointObject(Context context) {
    SharedPreferences prefs = Notifier.prefs(context);
    String url = prefs.getString(Notifier.ENDPOINT_URL, "");
    if (url.isEmpty()) return null;
    JSObject keys = new JSObject();
    keys.put("p256dh", prefs.getString(Notifier.ENDPOINT_P256DH, ""));
    keys.put("auth", prefs.getString(Notifier.ENDPOINT_AUTH, ""));
    JSObject endpoint = new JSObject();
    endpoint.put("endpoint", url);
    endpoint.put("keys", keys);
    return endpoint;
  }

  /** UnifiedPush distributors installed on this phone (package names), not counting this app. */
  private List<String> distributors() {
    List<String> out = new ArrayList<>();
    for (String d : UnifiedPush.getDistributors(getContext())) {
      if (!d.equals(getContext().getPackageName())) out.add(d);
    }
    return out;
  }

  private String permission() {
    if (Build.VERSION.SDK_INT < 33) return Notifier.allowed(getContext()) ? "granted" : "denied";
    PermissionState state = getPermissionState("notifications");
    if (state == PermissionState.GRANTED) return Notifier.allowed(getContext()) ? "granted" : "denied";
    if (state == PermissionState.DENIED) return "denied";
    return "prompt";
  }

  @PluginMethod
  public void status(PluginCall call) {
    SharedPreferences prefs = Notifier.prefs(getContext());
    JSObject out = new JSObject();
    out.put("permission", permission());
    out.put("daily", !prefs.getString(Notifier.CHECK_TOKEN, "").isEmpty());
    out.put("lastCheck", prefs.getLong(Notifier.LAST_CHECK, 0));
    JSArray list = new JSArray();
    for (String d : distributors()) list.put(d);
    out.put("distributors", list);
    String current = UnifiedPush.getAckDistributor(getContext());
    out.put("distributor", current);
    out.put("endpoint", endpointObject(getContext()));
    call.resolve(out);
  }

  @PluginMethod
  public void requestPermission(PluginCall call) {
    if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
      JSObject out = new JSObject();
      out.put("permission", permission());
      call.resolve(out);
      return;
    }
    requestPermissionForAlias("notifications", call, "permissionResult");
  }

  @PermissionCallback
  private void permissionResult(PluginCall call) {
    JSObject out = new JSObject();
    out.put("permission", permission());
    call.resolve(out);
  }

  /** Turns the daily check on, with the hub's address and this phone's check token. */
  @PluginMethod
  public void configure(PluginCall call) {
    String server = call.getString("serverUrl", "");
    String token = call.getString("checkToken", "");
    if (server == null || !server.startsWith("https://") || token == null || token.isEmpty()) {
      call.reject("An https server address and a check token are needed.", "INVALID");
      return;
    }
    Notifier.prefs(getContext()).edit().putString(Notifier.SERVER_URL, server).putString(Notifier.CHECK_TOKEN, token).apply();
    Notifier.schedule(getContext());
    call.resolve();
  }

  /**
   * Registers with the phone's UnifiedPush distributor (ntfy preferred) and
   * returns this phone's push address, or no address when none is installed.
   */
  @PluginMethod
  public void register(PluginCall call) {
    String vapid = call.getString("vapid", "");
    List<String> available = distributors();
    if (available.isEmpty()) {
      call.resolve(new JSObject());
      return;
    }
    String chosen = UnifiedPush.getAckDistributor(getContext());
    if (chosen == null || !available.contains(chosen)) chosen = available.contains(NTFY) ? NTFY : available.get(0);
    UnifiedPush.saveDistributor(getContext(), chosen);

    if (pending != null) pending.resolve(new JSObject());
    pending = call;
    pendingContext = getContext().getApplicationContext();
    pendingTimeout =
        () -> {
          if (pending == call) registrationDone(null, "The push app did not answer. Open it to check it is signed in and running.");
        };
    main.postDelayed(pendingTimeout, REGISTER_TIMEOUT_MS);
    try {
      UnifiedPush.register(getContext(), INSTANCE, "Family Hub reminders", vapid == null || vapid.isEmpty() ? null : vapid);
    } catch (Exception e) {
      registrationDone(null, "This phone's push app refused the registration.");
    }
  }

  /** Turns notifications off on this phone: no push registration, no daily check. */
  @PluginMethod
  public void disable(PluginCall call) {
    try {
      UnifiedPush.unregister(getContext(), INSTANCE);
    } catch (Exception ignored) {
      // Nothing registered.
    }
    Notifier.cancel(getContext());
    Notifier.prefs(getContext())
        .edit()
        .remove(Notifier.CHECK_TOKEN)
        .remove(Notifier.ENDPOINT_URL)
        .remove(Notifier.ENDPOINT_P256DH)
        .remove(Notifier.ENDPOINT_AUTH)
        .apply();
    call.resolve();
  }

  /** Runs the daily check now (when the app is opened). */
  @PluginMethod
  public void checkNow(PluginCall call) {
    final Context context = getContext().getApplicationContext();
    new Thread(
            () -> {
              JSObject out = new JSObject();
              try {
                out.put("shown", Notifier.check(context));
                call.resolve(out);
              } catch (Exception e) {
                call.reject("The hub could not be reached.", "UNREACHABLE");
              }
            },
            "family-hub-check-now")
        .start();
  }
}
