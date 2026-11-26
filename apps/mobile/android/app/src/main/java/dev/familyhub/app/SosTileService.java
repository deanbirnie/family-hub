package dev.familyhub.app;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;
import androidx.core.content.ContextCompat;
import org.json.JSONObject;

/**
 * SOS from the lock screen (phase 10c): a Quick Settings tile. A tap starts
 * the SOS service with the phone's SOS key (no unlocking, the owner's
 * choice) and shows the red SOS screen over the lock screen.
 */
public class SosTileService extends TileService {

  @Override
  public void onStartListening() {
    Tile tile = getQsTile();
    if (tile == null) return;
    tile.setState(SosService.running ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
    tile.setLabel("SOS");
    tile.setSubtitle(SosService.running ? "On" : null);
    tile.updateTile();
  }

  @Override
  public void onClick() {
    if (!SosService.running) {
      JSONObject store = SosVault.read(this);
      String server = store.optString("server", "");
      String deviceId = store.optString("deviceId", "");
      if (server.isEmpty() || deviceId.isEmpty() || !SosVault.hasKey()) {
        // Not set up yet: open the app (after unlocking) to set it up.
        open(false);
        return;
      }
      Intent sos = new Intent(this, SosService.class).putExtra("server", server).putExtra("deviceId", deviceId).putExtra("name", store.optString("name", ""));
      ContextCompat.startForegroundService(this, sos);
    }
    open(true);
    onStartListening();
  }

  /** The app, over the lock screen while an SOS is on (MainActivity shows itself when locked then). */
  @SuppressWarnings("deprecation")
  private void open(boolean sos) {
    Intent app = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("sos", sos);
    if (Build.VERSION.SDK_INT >= 34) {
      startActivityAndCollapse(PendingIntent.getActivity(this, 1, app, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
    } else {
      startActivityAndCollapse(app);
    }
  }
}
