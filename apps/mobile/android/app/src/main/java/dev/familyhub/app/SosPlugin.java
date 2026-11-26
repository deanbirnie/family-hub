package dev.familyhub.app;

import android.Manifest;
import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONObject;

/** Starts, reads and ends the SOS service (SosService.java) for the app's red SOS screen. */
@CapacitorPlugin(
    name = "Sos",
    permissions = {
      @Permission(alias = "location", strings = {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}),
      @Permission(alias = "sms", strings = {Manifest.permission.SEND_SMS})
    })
public class SosPlugin extends Plugin {

  @PluginMethod
  public void start(PluginCall call) {
    if (getPermissionState("location") != PermissionState.GRANTED) {
      requestPermissionForAlias("location", call, "afterPermission");
      return;
    }
    begin(call);
  }

  @PermissionCallback
  private void afterPermission(PluginCall call) {
    // Without location the SOS still alerts the family; it just cannot say where.
    begin(call);
  }

  private void begin(PluginCall call) {
    String server = call.getString("server");
    String id = call.getString("id");
    String pass = call.getString("pass");
    if (server == null || id == null || pass == null) {
      call.reject("Missing what the SOS needs.");
      return;
    }
    Intent intent = new Intent(getContext(), SosService.class).putExtra("server", server).putExtra("id", id).putExtra("pass", pass).putExtra("name", call.getString("name"));
    ContextCompat.startForegroundService(getContext(), intent);
    call.resolve();
  }

  /** Sets SOS up on this phone: location and SMS permissions, and the SOS key (its public half, for the hub). */
  @PluginMethod
  public void prepare(PluginCall call) {
    requestPermissionForAliases(new String[] {"location", "sms"}, call, "afterPrepare");
  }

  @PermissionCallback
  private void afterPrepare(PluginCall call) {
    try {
      JSObject out = new JSObject();
      out.put("publicKey", SosVault.publicKey());
      out.put("location", getPermissionState("location") == PermissionState.GRANTED);
      out.put("sms", getPermissionState("sms") == PermissionState.GRANTED);
      call.resolve(out);
    } catch (Exception e) {
      call.reject("The SOS key could not be made: " + e.getMessage());
    }
  }

  /** Keeps what a locked phone needs for an SOS (merged): server, deviceId, name, numbers, card. */
  @PluginMethod
  public void store(PluginCall call) {
    try {
      SosVault.merge(getContext(), new JSONObject(call.getData().toString()));
      call.resolve();
    } catch (Exception e) {
      call.reject("It could not be kept: " + e.getMessage());
    }
  }

  /** The details for the SOS screen (no fingerprint: the owner's choice), or null. */
  @PluginMethod
  public void card(PluginCall call) {
    JSObject out = new JSObject();
    JSONObject store = SosVault.read(getContext());
    try {
      out.put("card", store.has("card") ? JSObject.fromJSONObject(store.getJSONObject("card")) : null);
    } catch (Exception e) {
      out.put("card", null);
    }
    call.resolve(out);
  }

  /** Forgets the SOS key and the store (the phone signed out). */
  @PluginMethod
  public void forget(PluginCall call) {
    SosVault.forget(getContext());
    call.resolve();
  }

  @PluginMethod
  public void status(PluginCall call) {
    JSObject out = new JSObject();
    JSONObject store = SosVault.read(getContext());
    out.put("ready", SosVault.hasKey() && store.has("deviceId") && store.has("server"));
    out.put("sms", getPermissionState("sms") == PermissionState.GRANTED);
    out.put("active", SosService.running);
    out.put("id", SosService.sosId);
    out.put("waiting", SosService.waiting);
    out.put("lastSentAt", SosService.lastSentAt > 0 ? SosService.lastSentAt : null);
    out.put("lastFixAt", SosService.lastFixAt > 0 ? SosService.lastFixAt : null);
    call.resolve(out);
  }

  /** Ends the SOS with why, sending what is waiting with it. Rejects with no connection, and keeps the SOS on. */
  @PluginMethod
  public void end(PluginCall call) {
    SosService service = SosService.instance;
    if (service == null || SosService.sosId == null) {
      call.resolve();
      return;
    }
    String reason = call.getString("reason", "other");
    String note = call.getString("note", "");
    new Thread(
            () -> {
              try {
                JSONObject body = new JSONObject();
                body.put("pass", SosService.pass);
                body.put("reason", reason);
                body.put("note", note);
                body.put("points", service.waitingPoints());
                int status = SosService.post(SosService.server, "/api/safety/sos/" + SosService.sosId + "/end", body);
                if ((status >= 200 && status < 300) || status == 404 || status == 410) {
                  service.finish();
                  call.resolve();
                } else call.reject("The hub did not take it (" + status + "). Try again.", "server");
              } catch (Exception e) {
                call.reject("No connection: the SOS stays on. Try again when you have signal.", "offline");
              }
            })
        .start();
  }
}
