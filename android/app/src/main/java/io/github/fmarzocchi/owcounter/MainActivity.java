package io.github.fmarzocchi.owcounter;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.util.Arrays;

/** Apre l'app pubblicata su GitHub Pages. I link esterni (counterwatch, GitHub) vanno nel browser. */
public class MainActivity extends Activity {
    static final String HOME = "https://fmarzocchi.github.io/overwatch-counter/";
    static final int MAX_PHOTOS = 5; // foto del tabellone tenute nella cache, le più vecchie si cancellano
    static final int REQ_PHOTO = 7;
    private WebView web;
    private ValueCallback<Uri[]> photoCallback;
    private Uri cameraUri;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setBackgroundColor(0xFF11141A);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // profilo e partita restano salvati (localStorage)
        s.setCacheMode(WebSettings.LOAD_DEFAULT); // il service worker dell'app gestisce l'offline

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u.toString().startsWith(HOME)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                // primo avvio senza rete (nessuna copia salvata): messaggio chiaro con "riprova"
                if (req.isForMainFrame()) {
                    view.loadDataWithBaseURL(HOME, OFFLINE, "text/html", "utf-8", null);
                }
            }
        });

        // pulsante "Foto" dell'app: <input type=file capture> apre la fotocamera, senza capture la galleria
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (photoCallback != null) photoCallback.onReceiveValue(null);
                photoCallback = callback;
                cameraUri = null;
                if (params.isCaptureEnabled()) {
                    try {
                        File f = new File(PhotoProvider.dir(MainActivity.this), "foto-" + System.currentTimeMillis() + ".jpg");
                        prunePhotos();
                        cameraUri = PhotoProvider.uriFor(f);
                        Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                        cam.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                        cam.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivityForResult(cam, REQ_PHOTO);
                        return true;
                    } catch (ActivityNotFoundException | SecurityException e) {
                        cameraUri = null; // nessuna fotocamera: si sceglie dalla galleria
                    }
                }
                try {
                    startActivityForResult(params.createIntent(), REQ_PHOTO);
                } catch (ActivityNotFoundException e) {
                    photoCallback = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }
        });

        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl(HOME);
        }
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req != REQ_PHOTO || photoCallback == null) return;
        Uri[] got = null;
        if (cameraUri != null) {
            File f = new File(PhotoProvider.dir(this), cameraUri.getLastPathSegment());
            if (result == RESULT_OK && f.length() > 0) got = new Uri[] {cameraUri};
            else f.delete();
        } else {
            got = WebChromeClient.FileChooserParams.parseResult(result, data);
        }
        photoCallback.onReceiveValue(got);
        photoCallback = null;
        cameraUri = null;
    }

    /** Tiene solo le foto più recenti (con quella che sta per arrivare, al massimo MAX_PHOTOS). */
    private void prunePhotos() {
        File[] old = PhotoProvider.dir(this).listFiles();
        if (old == null) return;
        Arrays.sort(old, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
        for (int i = MAX_PHOTOS - 1; i < old.length; i++) old[i].delete();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private static final String OFFLINE =
        "<!doctype html><html lang='it'><meta name='viewport' content='width=device-width,initial-scale=1'>"
        + "<body style='background:#11141a;color:#eef1f5;font:18px system-ui;padding:32px;text-align:center'>"
        + "<h1 style='font-size:22px'>Nessuna connessione</h1>"
        + "<p>La prima volta serve internet per scaricare l'app. Poi funziona anche offline.</p>"
        + "<p><a href='" + HOME + "' style='display:inline-block;padding:14px 28px;border-radius:12px;"
        + "background:#f99e1a;color:#111;font-weight:700;text-decoration:none'>Riprova</a></p></body></html>";
}
