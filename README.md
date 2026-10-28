# Flowdeck

Webflow'da müşteri sitesi yöneten ajans ve freelancer'lar için tek panel: uptime, SSL, publish edilmemiş değişiklik, form gönderimleri, CMS limitleri, SEO temel kontrolleri, e-posta uyarıları, haftalık özet ve müşteriye gönderilecek beyaz etiketli rapor sayfası.

Salt okunur Webflow erişimi (sitelere hiçbir şey yazmaz). Sunucusuz: Vercel + Upstash Redis + Resend + cron-job.org, hepsi ücretsiz katmanda başlar.

## Dosyalar

```
api/index.js          tüm rotalar (auth, callback, app sayfaları, /r/{token} rapor, /cron/*)
api/_lib/webflow.js   Webflow Data API istemcisi (429 geri çekilme)
api/_lib/store.js     Redis veri erişimi (user, site, uptime listesi, alert durumu, rapor token)
api/_lib/checks.js    HTTP uptime ve TLS sertifika kontrolü
api/_lib/sync.js      Webflow verisi: sayfalar (SEO), formlar (7/30 gün), CMS sayıları
api/_lib/alerts.js    kurallar: down, ssl, unpublished, forms_silent; bir kez aç, bir kez kapat
api/_lib/jobs.js      zamanlanmış işler: checks (5 dk), sync (15 dk), digest (pazartesi)
api/_lib/email.js     Resend
api/_lib/html.js      sunucuda üretilen sayfalar (panel, site detayı, rapor, ayarlar)
public/               landing, privacy, terms, favicon
test/app.js           uçtan uca test: sahte Webflow, sahte Redis, sahte Resend, sahte müşteri siteleri (37 test)
assets/               logo (900 ve 256 px), Marketplace metinleri (listing.md)
```

## Nasıl çalışır

1. `/auth` → Webflow izin ekranı (scope'lar: `authorized_user:read sites:read pages:read cms:read forms:read`). Kullanıcı istediği siteleri seçer.
2. `/callback` → token şifrelenip kullanıcı kaydına yazılır (zamanlanmış işler için gerekli), siteler kaydedilir, ilk 5 site hemen senkronlanır ve bir uptime kontrolü yapılır.
3. `/cron/checks` (5 dakikada bir): her izlenen siteye HTTP isteği, saatte bir TLS sertifika tarihi, ardından uyarı kuralları. 2 ardışık hata = down. Uyarı e-postası problem başlayınca bir kez, bitince bir kez.
4. `/cron/sync` (15 dakikada bir): en uzun süredir senkronlanmamış 8 site için Webflow verisi (sayfa SEO alanları, form gönderim tarihleri, koleksiyon item sayıları). Böylece her site günde birkaç kez yenilenir, Webflow rate limit'i (60 istek/dk) aşılmaz.
5. `/cron/digest` (günde bir, sadece pazartesi gönderir): haftalık özet e-postası.
6. `/r/{token}`: müşteri raporu, oturum gerektirmez, `noindex`.

Plan limitleri `store.js` içinde: Free 1, Solo 5 ($9), Studio 15 ($24), Agency 40 ($49); yıllıkta 2 ay bedava. `COMPLIMENTARY_EMAILS` içindeki e-postalar ücretsiz Agency limiti alır. Kullanıcıya elle limit vermek için Redis'teki user kaydına `limitOverride` yazılır. Limit üstündeki siteler "Paused" olur, silinmez.

Ödeme Lemon Squeezy ile: Settings'teki butonlar `/app/billing/checkout` ile ödeme sayfası açar, webhook (`/billing/webhook`, `api/billing-webhook.mjs`) planı günceller. Store'daki varyant adları plan adını (Solo, Studio, Agency) ve yıllıklar için "Yearly" kelimesini içermeli.

## Yayına alma

1. **GitHub:** public `flowdeck` repo'su, bu klasör push.
2. **Webflow uygulama kaydı** (kendi workspace'in, waform'dan ayrı yeni uygulama): Apps & Integrations > Develop > Create an App. Name: Flowdeck. Building blocks: Data Client. Redirect URI: `https://<vercel-adresi>/callback`. Scope'lar: Authorized user (read), Sites (read), Pages (read), CMS (read), Forms (read). Client ID ve Secret.
3. **Vercel:** Add New Project → repo import → Deploy. Storage sekmesinden Upstash Redis oluştur ve projeye bağla (KV_REST_API_URL / TOKEN otomatik gelir). Environment Variables'a `.env.example`'daki kalan değerleri gir, Redeploy.
4. **Resend:** resend.com'da hesap, kendi domain'ini ekleyip DNS kayıtlarını (SPF, DKIM) gir, API key al → `RESEND_API_KEY`, `EMAIL_FROM`. Domain doğrulanana kadar e-postalar loglanır ve atlanır, uygulama çalışmaya devam eder.
5. **cron-job.org:** ücretsiz hesap, üç iş:
   - `GET https://<adres>/cron/checks?key=<CRON_SECRET>` her 5 dakika
   - `GET https://<adres>/cron/sync?key=<CRON_SECRET>` her 15 dakika
   - `GET https://<adres>/cron/digest?key=<CRON_SECRET>` her gün 07:00 UTC
   Zaman aşımını 60 saniye yap. Her iş kendi kilidini tutar, çakışma olmaz.
6. **Test:** `/auth` ile kendi workspace'ini bağla, 5 dakika sonra panelde uptime'ı gör, bir siteyi kasten bozmak yerine site ayarlarından "URL to check" alanına olmayan bir adres yazıp down uyarısını tetikle.
7. **Marketplace:** `assets/listing.md`.

## Geliştirme

```
npm test   # sahte servislerle uçtan uca test
npm run logo
```

Yerelde gerçek servislerle çalıştırmak için `npx vercel dev` ve `.env` dosyası.

## Yol haritası

- v1.1: haftalık kırık link taraması (sitemap üzerinden), PageSpeed skoru, Paddle ile ödeme, ekip üyeleri
- v1.2: Google Search Console ve GA4 verisini rapora ekleme (Google OAuth onayı gerekir), rapor için özel domain
- Her sürümde: Webflow Marketplace listesi ve landing güncellemesi

## Lisans

MIT. Webflow, Webflow Inc. markasıdır; Flowdeck bağımsız bir üründür.
