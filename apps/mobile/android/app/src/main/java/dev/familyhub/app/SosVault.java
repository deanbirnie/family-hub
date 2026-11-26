package dev.familyhub.app;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/**
 * What an SOS needs on a locked phone (phase 10c), all in the Android
 * Keystore, none of it behind a fingerprint (the owner's choice):
 *
 * <ul>
 *   <li>the <b>SOS key</b>, an ECDSA P-256 key the hub accepts only to start an
 *       SOS (never to unlock the app or read anything);
 *   <li>a small store, encrypted with a keystore AES key: the hub's address,
 *       this phone's id, the person's name, the family's mobile numbers for an
 *       SMS with no data, and the details shown on the SOS screen.
 * </ul>
 */
final class SosVault {

  private static final String KEYSTORE = "AndroidKeyStore";
  private static final String SIGN_ALIAS = "family-hub-sos-key";
  private static final String STORE_ALIAS = "family-hub-sos-store";
  private static final String FILE = "sos-store.bin";

  private SosVault() {}

  private static KeyStore keystore() throws Exception {
    KeyStore ks = KeyStore.getInstance(KEYSTORE);
    ks.load(null);
    return ks;
  }

  /** The SOS key's public half (base64 SubjectPublicKeyInfo), making the key if there is none. */
  static String publicKey() throws Exception {
    KeyStore ks = keystore();
    if (!ks.containsAlias(SIGN_ALIAS)) {
      KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE);
      g.initialize(
          new KeyGenParameterSpec.Builder(SIGN_ALIAS, KeyProperties.PURPOSE_SIGN)
              .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
              .setDigests(KeyProperties.DIGEST_SHA256)
              .build());
      g.generateKeyPair();
    }
    return Base64.encodeToString(ks.getCertificate(SIGN_ALIAS).getPublicKey().getEncoded(), Base64.NO_WRAP);
  }

  static boolean hasKey() {
    try {
      return keystore().containsAlias(SIGN_ALIAS);
    } catch (Exception e) {
      return false;
    }
  }

  /** Signs "family-hub-sos-start\n<challenge>\n<deviceId>" (DER, base64), as the hub expects. */
  static String sign(String challenge, String deviceId) throws Exception {
    PrivateKey key = (PrivateKey) keystore().getKey(SIGN_ALIAS, null);
    Signature s = Signature.getInstance("SHA256withECDSA");
    s.initSign(key);
    s.update(("family-hub-sos-start\n" + challenge + "\n" + deviceId).getBytes(StandardCharsets.UTF_8));
    return Base64.encodeToString(s.sign(), Base64.NO_WRAP);
  }

  private static SecretKey storeKey() throws Exception {
    KeyStore ks = keystore();
    if (!ks.containsAlias(STORE_ALIAS)) {
      KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
      g.init(
          new KeyGenParameterSpec.Builder(STORE_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
              .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
              .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
              .setKeySize(256)
              .build());
      g.generateKey();
    }
    return (SecretKey) ks.getKey(STORE_ALIAS, null);
  }

  /** The store, or an empty object. */
  static JSONObject read(Context context) {
    try {
      File f = new File(context.getFilesDir(), FILE);
      if (!f.exists()) return new JSONObject();
      ByteBuffer b = ByteBuffer.wrap(Files.readAllBytes(f.toPath()));
      byte[] iv = new byte[12];
      b.get(iv);
      byte[] ct = new byte[b.remaining()];
      b.get(ct);
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(Cipher.DECRYPT_MODE, storeKey(), new GCMParameterSpec(128, iv));
      return new JSONObject(new String(c.doFinal(ct), StandardCharsets.UTF_8));
    } catch (Exception e) {
      return new JSONObject();
    }
  }

  /** Merges `changes` into the store. */
  static void merge(Context context, JSONObject changes) throws Exception {
    JSONObject current = read(context);
    java.util.Iterator<String> keys = changes.keys();
    while (keys.hasNext()) {
      String k = keys.next();
      current.put(k, changes.get(k));
    }
    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
    c.init(Cipher.ENCRYPT_MODE, storeKey());
    byte[] ct = c.doFinal(current.toString().getBytes(StandardCharsets.UTF_8));
    try (FileOutputStream out = new FileOutputStream(new File(context.getFilesDir(), FILE))) {
      out.write(c.getIV());
      out.write(ct);
    }
  }

  /** Forgets everything (the phone signed out). */
  static void forget(Context context) {
    new File(context.getFilesDir(), FILE).delete();
    try {
      KeyStore ks = keystore();
      ks.deleteEntry(SIGN_ALIAS);
      ks.deleteEntry(STORE_ALIAS);
    } catch (Exception e) {
      // Nothing to forget.
    }
  }
}
