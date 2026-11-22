package dev.familyhub.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
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
import java.nio.ByteBuffer;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Keeps the family vault's key on this phone, wrapped by an AES-256 key in
 * the Android Keystore (StrongBox where available).
 *
 * <p>The keystore key cannot be read out and only works for 30 seconds after
 * a strong (class 3) fingerprint or face check. The check that opens the app
 * counts, so the vault opens without a second prompt; otherwise this plugin
 * asks for one. Enrolling a new fingerprint or face destroys the key, so the
 * vault must then be reached again from another device or the recovery key.
 *
 * <p>The wrapped family key is stored on the server, which cannot open it.
 */
@CapacitorPlugin(name = "VaultKey")
public class VaultKeyPlugin extends Plugin {

  private static final String KEYSTORE = "AndroidKeyStore";
  private static final String ALIAS = "family-hub-vault-key";
  private static final String TRANSFORMATION = "AES/GCM/NoPadding";
  private static final int AUTH_SECONDS = 30;

  private interface Operation {
    String run() throws Exception;
  }

  /** Encrypts the family key (base64) with this phone's vault key; returns base64(iv ‖ ciphertext). */
  @PluginMethod
  public void wrap(final PluginCall call) {
    final byte[] plain;
    try {
      plain = Base64.decode(call.getString("data", ""), Base64.NO_WRAP);
    } catch (IllegalArgumentException e) {
      call.reject("Bad data", "FAILED");
      return;
    }
    withAuthentication(
        call,
        () -> {
          SecretKey key = key(true);
          Cipher cipher = Cipher.getInstance(TRANSFORMATION);
          cipher.init(Cipher.ENCRYPT_MODE, key);
          byte[] iv = cipher.getIV();
          byte[] ct = cipher.doFinal(plain);
          return Base64.encodeToString(ByteBuffer.allocate(iv.length + ct.length).put(iv).put(ct).array(), Base64.NO_WRAP);
        });
  }

  /** Decrypts what wrap() produced; returns the family key (base64). */
  @PluginMethod
  public void unwrap(final PluginCall call) {
    final byte[] sealed;
    try {
      sealed = Base64.decode(call.getString("data", ""), Base64.NO_WRAP);
    } catch (IllegalArgumentException e) {
      call.reject("Bad data", "FAILED");
      return;
    }
    if (sealed.length < 12 + 16) {
      call.reject("The vault data is damaged.", "FAILED");
      return;
    }
    withAuthentication(
        call,
        () -> {
          SecretKey key = key(false);
          if (key == null) throw new KeyPermanentlyInvalidatedException();
          Cipher cipher = Cipher.getInstance(TRANSFORMATION);
          cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, sealed, 0, 12));
          return Base64.encodeToString(cipher.doFinal(sealed, 12, sealed.length - 12), Base64.NO_WRAP);
        });
  }

  @PluginMethod
  public void forget(PluginCall call) {
    deleteKey();
    call.resolve();
  }

  /** Runs the operation; if the keystore wants a fresh check, asks for a fingerprint or face once, then retries. */
  private void withAuthentication(final PluginCall call, final Operation op) {
    new Thread(
            () -> {
              try {
                resolve(call, op.run());
              } catch (UserNotAuthenticatedException e) {
                prompt(call, op);
              } catch (KeyPermanentlyInvalidatedException e) {
                deleteKey();
                call.reject("The fingerprints or face on this phone have changed.", "INVALIDATED");
              } catch (Exception e) {
                call.reject("This phone could not open the family vault.", "FAILED", e);
              }
            })
        .start();
  }

  private void prompt(final PluginCall call, final Operation op) {
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
                                  resolve(call, op.run());
                                } catch (KeyPermanentlyInvalidatedException e) {
                                  deleteKey();
                                  call.reject("The fingerprints or face on this phone have changed.", "INVALIDATED");
                                } catch (Exception e) {
                                  call.reject("This phone could not open the family vault.", "FAILED", e);
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
                  .setTitle("Open the family vault")
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

  /** The vault key; made on first use when `create` is set, otherwise null if there is none. */
  private SecretKey key(boolean create) throws Exception {
    KeyStore store = KeyStore.getInstance(KEYSTORE);
    store.load(null);
    SecretKey existing = (SecretKey) store.getKey(ALIAS, null);
    if (existing != null || !create) return existing;
    try {
      return generate(true);
    } catch (StrongBoxUnavailableException e) {
      return generate(false);
    }
  }

  private SecretKey generate(boolean strongBox) throws Exception {
    KeyGenParameterSpec.Builder spec =
        new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(AUTH_SECONDS, KeyProperties.AUTH_BIOMETRIC_STRONG)
            .setInvalidatedByBiometricEnrollment(true);
    if (strongBox) spec.setIsStrongBoxBacked(true);
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
    generator.init(spec.build());
    return generator.generateKey();
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
