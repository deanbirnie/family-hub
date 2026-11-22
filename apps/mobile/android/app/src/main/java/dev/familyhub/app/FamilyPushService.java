package dev.familyhub.app;

import androidx.annotation.NonNull;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PublicKeySet;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/**
 * Receives UnifiedPush events from the distributor the person chose (ntfy,
 * for example). Messages are encrypted to this phone (RFC 8291); the
 * connector library decrypts them with keys it keeps on the phone.
 */
public class FamilyPushService extends PushService {

  @Override
  public void onNewEndpoint(@NonNull PushEndpoint endpoint, @NonNull String instance) {
    PublicKeySet keys = endpoint.getPubKeySet();
    if (keys == null) {
      PushPlugin.registrationDone(null, "The push service did not give this phone encryption keys.");
      return;
    }
    Notifier.prefs(this)
        .edit()
        .putString(Notifier.ENDPOINT_URL, endpoint.getUrl())
        .putString(Notifier.ENDPOINT_P256DH, keys.getPubKey())
        .putString(Notifier.ENDPOINT_AUTH, keys.getAuth())
        .apply();
    PushPlugin.registrationDone(endpoint.getUrl(), null);
  }

  @Override
  public void onMessage(@NonNull PushMessage message, @NonNull String instance) {
    // Only the hub can encrypt to this phone's keys; anything else is ignored.
    if (!message.getDecrypted()) return;
    Notifier.showMessage(this, message.getContent());
  }

  @Override
  public void onRegistrationFailed(@NonNull FailedReason reason, @NonNull String instance) {
    PushPlugin.registrationDone(null, "The push service could not register this phone (" + reason.name() + ").");
  }

  @Override
  public void onUnregistered(@NonNull String instance) {
    Notifier.prefs(this).edit().remove(Notifier.ENDPOINT_URL).remove(Notifier.ENDPOINT_P256DH).remove(Notifier.ENDPOINT_AUTH).apply();
  }
}
