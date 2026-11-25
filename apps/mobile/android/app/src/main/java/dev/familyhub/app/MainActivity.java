package dev.familyhub.app;

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
    super.onCreate(savedInstanceState);
    // Family information (and later ID numbers) must not show in the recent-apps
    // preview or in screenshots and screen recordings taken by other apps.
    getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
  }
}
