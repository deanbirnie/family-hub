package dev.familyhub.app;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

/**
 * The phone's sign-in key for Family Hub.
 *
 * <p>An ECDSA P-256 key pair is made inside the Android Keystore (in the
 * StrongBox secure chip where the phone has one, otherwise in its trusted
 * execution environment). The private key cannot be read out, and is set up so
 * that it signs only straight after a strong (class 3) fingerprint or face
 * check, once per check. Enrolling a new fingerprint or face destroys it, so
 * someone who adds their own fingerprint to the phone cannot use it.
 *
 * <p>The server holds the public key and only issues a session for a fresh
 * challenge signed by it (see apps/server/src/routes/devices.ts).
 */
@CapacitorPlugin(name = "DeviceAuth")
public class DeviceAuthPlugin extends Plugin {

  private static final String KEYSTORE = "AndroidKeyStore";
  private static final String ALIAS = "family-hub-device-key";
  private static final int STRONG = BiometricManager.Authenticators.BIOMETRIC_STRONG;

  @PluginMethod
  public void status(PluginCall call) {
    int status = BiometricManager.from(getContext()).canAuthenticate(STRONG);
    JSObject out = new JSObject();
    out.put("available", status == BiometricManager.BIOMETRIC_SUCCESS);
    switch (status) {
      case BiometricManager.BIOMETRIC_SUCCESS:
        break;
      case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
        out.put("reason", "Set up a fingerprint or face unlock in Android’s settings (Security), then check again.");
        break;
      case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
      case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
        out.put("reason", "This phone has no fingerprint or face sensor that is secure enough. Family Hub needs one.");
        break;
      case BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED:
        out.put("reason", "Install the latest Android security update, then check again.");
        break;
      default:
        out.put("reason", "Fingerprint or face unlock is not available on this phone right now.");
    }
    out.put("hasKey", hasKey());
    out.put("model", Build.MANUFACTURER + " " + Build.MODEL);
    call.resolve(out);
  }

  /** Makes a fresh key pair (replacing any old one) and returns the public key, SPKI DER in base64. */
  @PluginMethod
  public void createKey(PluginCall call) {
    try {
      deleteEntry();
      PublicKey publicKey;
      try {
        publicKey = generate(true);
      } catch (StrongBoxUnavailableException e) {
        publicKey = generate(false);
      }
      JSObject out = new JSObject();
      out.put("publicKey", Base64.encodeToString(publicKey.getEncoded(), Base64.NO_WRAP));
      call.resolve(out);
    } catch (Exception e) {
      call.reject("Could not make a secure key on this phone", "FAILED", e);
    }
  }

  private PublicKey generate(boolean strongBox) throws Exception {
    KeyGenParameterSpec.Builder spec =
        new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            // 0 seconds: every signature needs its own fingerprint or face check.
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            .setInvalidatedByBiometricEnrollment(true);
    if (strongBox) spec.setIsStrongBoxBacked(true);
    KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE);
    generator.initialize(spec.build());
    return generator.generateKeyPair().getPublic();
  }

  /** Asks for a fingerprint or face, then signs the message (base64) with SHA256withECDSA. */
  @PluginMethod
  public void sign(final PluginCall call) {
    final byte[] message;
    try {
      message = Base64.decode(call.getString("message", ""), Base64.NO_WRAP);
    } catch (IllegalArgumentException e) {
      call.reject("Bad message", "FAILED");
      return;
    }
    final Signature signature;
    try {
      KeyStore store = KeyStore.getInstance(KEYSTORE);
      store.load(null);
      PrivateKey key = (PrivateKey) store.getKey(ALIAS, null);
      if (key == null) throw new KeyPermanentlyInvalidatedException();
      signature = Signature.getInstance("SHA256withECDSA");
      signature.initSign(key);
    } catch (KeyPermanentlyInvalidatedException e) {
      deleteEntry();
      call.reject("The fingerprints or face on this phone have changed.", "INVALIDATED");
      return;
    } catch (Exception e) {
      call.reject("Fingerprint unlock is not working on this phone.", "FAILED", e);
      return;
    }
    final String title = call.getString("title", "Unlock Family Hub");
    final String subtitle = call.getString("subtitle", "");
    final FragmentActivity activity = getActivity();
    activity.runOnUiThread(
        () -> {
          BiometricPrompt prompt =
              new BiometricPrompt(
                  activity,
                  ContextCompat.getMainExecutor(activity),
                  new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                      try {
                        BiometricPrompt.CryptoObject crypto = result.getCryptoObject();
                        if (crypto == null || crypto.getSignature() == null) throw new IllegalStateException("no signature");
                        Signature ready = crypto.getSignature();
                        ready.update(message);
                        JSObject out = new JSObject();
                        out.put("signature", Base64.encodeToString(ready.sign(), Base64.NO_WRAP));
                        call.resolve(out);
                      } catch (Exception e) {
                        call.reject("Fingerprint unlock is not working on this phone.", "FAILED", e);
                      }
                    }

                    @Override
                    public void onAuthenticationError(int code, @NonNull CharSequence text) {
                      boolean cancelled =
                          code == BiometricPrompt.ERROR_USER_CANCELED
                              || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                              || code == BiometricPrompt.ERROR_CANCELED;
                      call.reject(text.toString(), cancelled ? "CANCELLED" : "FAILED");
                    }
                    // onAuthenticationFailed (a finger not recognised) needs nothing:
                    // the prompt stays open and lets the person try again.
                  });
          BiometricPrompt.PromptInfo info =
              new BiometricPrompt.PromptInfo.Builder()
                  .setTitle(title)
                  .setSubtitle(subtitle)
                  .setAllowedAuthenticators(STRONG)
                  .setNegativeButtonText("Cancel")
                  .setConfirmationRequired(false)
                  .build();
          prompt.authenticate(info, new BiometricPrompt.CryptoObject(signature));
        });
  }

  @PluginMethod
  public void deleteKey(PluginCall call) {
    deleteEntry();
    call.resolve();
  }

  private boolean hasKey() {
    try {
      KeyStore store = KeyStore.getInstance(KEYSTORE);
      store.load(null);
      return store.containsAlias(ALIAS);
    } catch (Exception e) {
      return false;
    }
  }

  private void deleteEntry() {
    try {
      KeyStore store = KeyStore.getInstance(KEYSTORE);
      store.load(null);
      if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS);
    } catch (Exception ignored) {
      // nothing to delete
    }
  }
}
