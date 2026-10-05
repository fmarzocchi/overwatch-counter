package io.github.fmarzocchi.owcounter;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Apre l'app pubblicata su GitHub Pages. I link esterni (counterwatch, GitHub) vanno nel browser. */
public class MainActivity extends Activity {
    static final String HOME = "https://fmarzocchi.github.io/overwatch-counter/";
    private WebView web;

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

        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl(HOME);
        }
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
