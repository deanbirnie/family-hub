package dev.familyhub.app;

import android.Manifest;
import android.content.Context;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.CancellationSignal;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.concurrent.Executors;

/**
 * The phone's location at this moment (phase 10: "Arrived"), from Android's
 * own location service: no Google Play services and no other library. Asks
 * for the location permission the first time.
 */
@CapacitorPlugin(
    name = "Location",
    permissions = {@Permission(alias = "location", strings = {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION})})
public class LocationPlugin extends Plugin {

  private static final long TIMEOUT_MS = 30_000;

  @PluginMethod
  public void current(PluginCall call) {
    if (getPermissionState("location") != PermissionState.GRANTED) {
      requestPermissionForAlias("location", call, "afterPermission");
      return;
    }
    locate(call);
  }

  @PermissionCallback
  private void afterPermission(PluginCall call) {
    if (getPermissionState("location") != PermissionState.GRANTED) {
      call.reject("Location is off for Family Hub. Allow it in the phone's settings to share where you are.", "denied");
      return;
    }
    locate(call);
  }

  @SuppressWarnings("MissingPermission")
  private void locate(PluginCall call) {
    LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
    if (lm == null || !lm.isLocationEnabled()) {
      call.reject("The phone's location is turned off. Turn it on to share where you are.", "off");
      return;
    }
    String provider;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && lm.hasProvider(LocationManager.FUSED_PROVIDER)) provider = LocationManager.FUSED_PROVIDER;
    else if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) provider = LocationManager.GPS_PROVIDER;
    else provider = LocationManager.NETWORK_PROVIDER;
    CancellationSignal cancel = new CancellationSignal();
    final boolean[] done = {false};
    // Gives up after a while, with the last known location if there is one.
    new android.os.Handler(android.os.Looper.getMainLooper())
        .postDelayed(
            () -> {
              synchronized (done) {
                if (done[0]) return;
                done[0] = true;
              }
              cancel.cancel();
              Location last = lm.getLastKnownLocation(provider);
              if (last != null) call.resolve(toJs(last));
              else call.reject("The phone could not find where it is. Try again outside or near a window.", "timeout");
            },
            TIMEOUT_MS);
    lm.getCurrentLocation(
        provider,
        cancel,
        Executors.newSingleThreadExecutor(),
        location -> {
          synchronized (done) {
            if (done[0]) return;
            done[0] = true;
          }
          if (location != null) call.resolve(toJs(location));
          else call.reject("The phone could not find where it is. Try again outside or near a window.", "unavailable");
        });
  }

  private static JSObject toJs(Location l) {
    JSObject out = new JSObject();
    out.put("latitude", l.getLatitude());
    out.put("longitude", l.getLongitude());
    out.put("accuracy", l.hasAccuracy() ? (double) l.getAccuracy() : null);
    out.put("at", l.getTime());
    return out;
  }
}
