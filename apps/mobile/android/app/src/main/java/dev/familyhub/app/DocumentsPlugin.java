package dev.familyhub.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLConnection;
import java.util.UUID;

/** Uses the current session to save/open documents. No biometric operation. */
@CapacitorPlugin(name = "Documents")
public class DocumentsPlugin extends Plugin {
  private volatile long generation = 0;
  private File folder() {
    File dir = new File(getContext().getCacheDir(), "documents");
    dir.mkdirs();
    return dir;
  }
  @Override public void load() { clearFiles(); }
  private void clearFiles() {
    File[] files = folder().listFiles();
    if (files != null) for (File f : files) f.delete();
  }
  @PluginMethod public void clear(PluginCall call) {
    generation++;
    clearFiles();
    call.resolve();
  }
  @PluginMethod public void download(PluginCall call) {
    String name = call.getString("name", "document");
    String action = call.getString("action", "save");
    if (name.contains("/") || name.contains("\\") || !(action.equals("save") || action.equals("open"))) {
      call.reject("Invalid document request"); return;
    }
    final long started = generation;
    new Thread(() -> {
      File target = new File(folder(), UUID.randomUUID().toString());
      HttpURLConnection connection = null;
      try {
        URL url = new URL(call.getString("url", ""));
        // Only documents, and vCard exports of the address book, ever go to the server with the token.
        boolean allowedPath = url.getPath().matches("/api/files/[a-f0-9-]{36}/content") || url.getPath().matches("/api/contacts/export/(all|[A-Za-z0-9_-]{16})(-notes)?\\.vcf");
        if (!url.getProtocol().equals("https") || !allowedPath || url.getUserInfo() != null || url.getQuery() != null) {
          throw new Exception("Invalid document address");
        }
        connection = (HttpURLConnection) url.openConnection();
        // Never forward the session token to a redirect destination.
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(60_000);
        connection.setRequestProperty("Authorization", "Bearer " + call.getString("token", ""));
        int status = connection.getResponseCode();
        if (status == 401) { call.reject("Please unlock Family Hub again.", "UNAUTHENTICATED"); return; }
        if (status != 200) throw new Exception("Could not download this document (" + status + ")");
        try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(target)) {
          byte[] buffer = new byte[64 * 1024];
          int n;
          while ((n = in.read(buffer)) != -1) {
            if (started != generation) throw new Exception("Family Hub was locked. Please try again.");
            out.write(buffer, 0, n);
          }
        }
        if (started != generation) throw new Exception("Family Hub was locked. Please try again.");
        String type = URLConnection.guessContentTypeFromName(name);
        final String mime = type == null ? "application/octet-stream" : type;
        // Never save the token with Android's pending activity callback.
        call.getData().remove("token");
        call.getData().put("cachedFile", target.getName());
        getActivity().runOnUiThread(() -> {
          try {
            if (started != generation) throw new Exception("Family Hub was locked. Please try again.");
            if (action.equals("save")) {
              Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
              save.addCategory(Intent.CATEGORY_OPENABLE);
              save.setType(mime);
              save.putExtra(Intent.EXTRA_TITLE, name);
              startActivityForResult(call, save, "saveDocument");
            } else {
              Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", target);
              Intent view = new Intent(Intent.ACTION_VIEW);
              view.setDataAndType(uri, mime);
              view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
              getActivity().startActivity(Intent.createChooser(view, "Open " + name));
              call.resolve();
            }
          } catch (Exception e) { target.delete(); call.reject("Could not open this document. Try saving it instead."); }
        });
      } catch (Exception e) {
        target.delete();
        call.reject(e.getMessage() == null ? "The download failed" : e.getMessage());
      } finally { if (connection != null) connection.disconnect(); }
    }).start();
  }
  @ActivityCallback protected void saveDocument(PluginCall call, ActivityResult result) {
    if (call == null) return;
    String cached = call.getString("cachedFile", "");
    if (!cached.matches("[a-f0-9-]{36}")) { call.reject("Please download this document again."); return; }
    File source = new File(folder(), cached);
    if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
      source.delete(); call.resolve(); return;
    }
    Uri destination = result.getData().getData();
    if (destination == null) { source.delete(); call.reject("No save location was selected."); return; }
    new Thread(() -> {
      try (InputStream in = new FileInputStream(source); OutputStream out = getContext().getContentResolver().openOutputStream(destination, "w")) {
        if (out == null) throw new Exception("Could not open the save location");
        byte[] buffer = new byte[64 * 1024];
        int n;
        while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
        call.resolve();
      } catch (Exception e) { call.reject("Could not save this document. Please try again."); }
      finally { source.delete(); }
    }).start();
  }
}
