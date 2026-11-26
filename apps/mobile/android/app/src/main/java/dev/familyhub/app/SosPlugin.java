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
    permissions = {@Permission(alias = "location", strings = {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION})})
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
    Intent intent = new Intent(getContext(), SosService.class).putExtra("server", server).putExtra("id", id).putExtra("pass", pass);
    ContextCompat.startForegroundService(getContext(), intent);
    call.resolve();
  }

  @PluginMethod
  public void status(PluginCall call) {
    JSObject out = new JSObject();
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
