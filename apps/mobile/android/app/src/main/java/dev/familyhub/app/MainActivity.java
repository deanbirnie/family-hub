package dev.familyhub.app;

import android.content.Intent;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Plugins that live in this app (rather than in an npm package) are registered by hand.
    registerPlugin(DeviceAuthPlugin.class);
    registerPlugin(VaultKeyPlugin.class);
    registerPlugin(AppUpdatePlugin.class);
    registerPlugin(DocumentsPlugin.class);
    registerPlugin(PushPlugin.class);
    registerPlugin(EmergencyCardPlugin.class);
    registerPlugin(LocationPlugin.class);
    registerPlugin(SosPlugin.class);
    super.onCreate(savedInstanceState);
    // Family information (and later ID numbers) must not show in the recent-apps
    // preview or in screenshots and screen recordings taken by other apps.
    getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    showOverLockWhileSos(getIntent());
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    showOverLockWhileSos(intent);
  }

  @Override
  public void onResume() {
    super.onResume();
    showOverLockWhileSos(getIntent());
  }

  /**
   * While an SOS is on (or one is starting from the lock screen), the app shows
   * over the lock screen so its red SOS screen can be read and ended there. At
   * any other time it does not: the app itself still needs a fingerprint.
   */
  private void showOverLockWhileSos(Intent intent) {
    boolean sos = SosService.running || (intent != null && intent.getBooleanExtra("sos", false));
    setShowWhenLocked(sos);
    setTurnScreenOn(sos);
    if (!SosService.running && intent != null) intent.removeExtra("sos");
  }
}
