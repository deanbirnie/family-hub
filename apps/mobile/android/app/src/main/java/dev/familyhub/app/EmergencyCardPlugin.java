package dev.familyhub.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.UserNotAuthenticatedException;
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
import java.security.spec.MGF1ParameterSpec;
import javax.crypto.Cipher;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;

/**
 * The key for the offline emergency card: an RSA key pair in the Android
 * Keystore.
 *
 * <p>The app encrypts the card with the public key whenever the family vault
 * is open, without asking for a fingerprint. Only the private key can open
 * it, and that works only for 30 seconds after a strong fingerprint or face
 * check, and never leaves the keystore. It needs no network, so the card opens
 * from the locked screen in a hospital with no signal. Enrolling a new
 * fingerprint or face destroys the key; the card is then made again the next
 * time the vault is open.
 *
 * <p>OAEP with SHA-1 is used because it is what the keystore supports on every
 * Android version the app runs on (and is still sound for encryption).
 */
@CapacitorPlugin(name = "EmergencyCard")
public class EmergencyCardPlugin extends Plugin {

  private static final String KEYSTORE = "AndroidKeyStore";
  private static final String ALIAS = "family-hub-emergency-card";
  private static final String TRANSFORMATION = "RSA/ECB/OAEPWithSHA-1AndMGF1Padding";
  private static final int AUTH_SECONDS = 30;

  /** The public key (base64 SubjectPublicKeyInfo), making the pair if there is none. No fingerprint needed. */
  @PluginMethod
  public void publicKey(final PluginCall call) {
    new Thread(
            () -> {
              try {
                KeyStore store = KeyStore.getInstance(KEYSTORE);
                store.load(null);
                if (!store.containsAlias(ALIAS)) generate();
                JSObject out = new JSObject();
                out.put("data", Base64.encodeToString(store.getCertificate(ALIAS).getPublicKey().getEncoded(), Base64.NO_WRAP));
                call.resolve(out);
              } catch (Exception e) {
                call.reject("This phone could not keep the emergency card.", "FAILED", e);
              }
            })
        .start();
  }

  /** Decrypts the card's wrapped key (base64) after a fingerprint or face check; returns it (base64). */
  @PluginMethod
  public void open(final PluginCall call) {
    final byte[] wrapped;
    try {
      wrapped = Base64.decode(call.getString("data", ""), Base64.NO_WRAP);
    } catch (IllegalArgumentException e) {
      call.reject("The emergency card is damaged.", "FAILED");
      return;
    }
    new Thread(
            () -> {
              try {
                resolve(call, decrypt(wrapped));
              } catch (UserNotAuthenticatedException e) {
                prompt(call, wrapped);
              } catch (KeyPermanentlyInvalidatedException e) {
                deleteKey();
                call.reject("The fingerprints or face on this phone have changed.", "INVALIDATED");
              } catch (Exception e) {
                call.reject("This phone could not open the emergency card.", "FAILED", e);
              }
            })
        .start();
  }

  @PluginMethod
  public void forget(PluginCall call) {
    deleteKey();
    call.resolve();
  }

  private String decrypt(byte[] wrapped) throws Exception {
    KeyStore store = KeyStore.getInstance(KEYSTORE);
    store.load(null);
    PrivateKey key = (PrivateKey) store.getKey(ALIAS, null);
    if (key == null) throw new KeyPermanentlyInvalidatedException();
    Cipher cipher = Cipher.getInstance(TRANSFORMATION);
    cipher.init(Cipher.DECRYPT_MODE, key, new OAEPParameterSpec("SHA-1", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT));
    return Base64.encodeToString(cipher.doFinal(wrapped), Base64.NO_WRAP);
  }

  private void prompt(final PluginCall call, final byte[] wrapped) {
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
                      new Thread(
                              () -> {
                                try {
                                  resolve(call, decrypt(wrapped));
                                } catch (KeyPermanentlyInvalidatedException e) {
                                  deleteKey();
                                  call.reject("The fingerprints or face on this phone have changed.", "INVALIDATED");
                                } catch (Exception e) {
                                  call.reject("This phone could not open the emergency card.", "FAILED", e);
                                }
                              })
                          .start();
                    }

                    @Override
                    public void onAuthenticationError(int code, @NonNull CharSequence text) {
                      boolean cancelled =
                          code == BiometricPrompt.ERROR_USER_CANCELED
                              || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                              || code == BiometricPrompt.ERROR_CANCELED;
                      call.reject(text.toString(), cancelled ? "CANCELLED" : "FAILED");
                    }
                  });
          BiometricPrompt.PromptInfo info =
              new BiometricPrompt.PromptInfo.Builder()
                  .setTitle("Open the emergency card")
                  .setSubtitle("Use your fingerprint or face")
                  .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                  .setNegativeButtonText("Cancel")
                  .setConfirmationRequired(false)
                  .build();
          prompt.authenticate(info);
        });
  }

  private static void resolve(PluginCall call, String data) {
    JSObject out = new JSObject();
    out.put("data", data);
    call.resolve(out);
  }

  private void generate() throws Exception {
    KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, KEYSTORE);
    generator.initialize(
        new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(2048)
            .setDigests(KeyProperties.DIGEST_SHA1, KeyProperties.DIGEST_SHA256)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(AUTH_SECONDS, KeyProperties.AUTH_BIOMETRIC_STRONG)
            .setInvalidatedByBiometricEnrollment(true)
            .build());
    generator.generateKeyPair();
  }

  private void deleteKey() {
    try {
      KeyStore store = KeyStore.getInstance(KEYSTORE);
      store.load(null);
      if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS);
    } catch (Exception ignored) {
      // nothing to delete
    }
  }
}
