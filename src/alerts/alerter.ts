import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";
import { log } from "../lib/logger.js";
import { fingerprint } from "../lib/text.js";
import type { Db, AlertSeverity } from "../db/client.js";

export interface AlertInput {
  severity: AlertSeverity;
  /** Aynı hatayı gruplamak için sabit anahtar */
  key: string;
  title: string;
  /** Gövdede tablo olarak gösterilir */
  details?: Record<string, unknown>;
  error?: unknown;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const COLORS: Record<AlertSeverity, string> = {
  info: "#2563eb", warning: "#d97706", critical: "#dc2626",
};

const LABELS: Record<AlertSeverity, string> = {
  info: "BİLGİ", warning: "UYARI", critical: "KRİTİK",
};

function renderHtml(a: AlertInput, suppressed: number): string {
  const rows = Object.entries(a.details ?? {})
    .map(([k, v]) => `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;white-space:nowrap">${esc(k)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;font-family:ui-monospace,monospace;font-size:13px">${esc(v)}</td>
      </tr>`)
    .join("");

  const errBlock = a.error
    ? `<pre style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;
         font-size:12px;overflow-x:auto;white-space:pre-wrap;color:#374151">${
         esc(a.error instanceof Error ? `${a.error.message}\n${a.error.stack ?? ""}` : a.error)
           .slice(0, 3000)}</pre>`
    : "";

  const supNote = suppressed > 0
    ? `<p style="color:#6b7280;font-size:13px;margin:12px 0 0">
         Bu hata sessizlik penceresinde ${suppressed} kez daha tekrarlandı.</p>`
    : "";

  return `<!doctype html><html lang="tr"><body style="margin:0;padding:24px;
    background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
    <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;
      box-shadow:0 1px 3px rgba(0,0,0,.1)">
      <div style="background:${COLORS[a.severity]};color:#fff;padding:16px 20px">
        <div style="font-size:12px;letter-spacing:.08em;opacity:.9">${LABELS[a.severity]}</div>
        <div style="font-size:18px;font-weight:600;margin-top:2px">${esc(a.title)}</div>
      </div>
      <div style="padding:20px">
        <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
        ${errBlock}
        ${supNote}
        <p style="color:#9ca3af;font-size:12px;margin:20px 0 0;
          border-top:1px solid #e5e7eb;padding-top:12px">
          ${esc(env.instanceId)} · ${new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}
        </p>
      </div>
    </div></body></html>`;
}

function renderText(a: AlertInput): string {
  const lines = [`[${LABELS[a.severity]}] ${a.title}`, ""];
  for (const [k, v] of Object.entries(a.details ?? {})) lines.push(`${k}: ${v}`);
  if (a.error) {
    lines.push("", a.error instanceof Error ? a.error.message : String(a.error));
  }
  lines.push("", `${env.instanceId} · ${new Date().toISOString()}`);
  return lines.join("\n");
}

/**
 * Mail bildirimi.
 *
 * TASARIM: Bastırma mantığı BURADA DEĞİL, DB'de (bot_should_alert).
 * Sebep: birden fazla container çalışırsa bellekteki cooldown
 * her container'da ayrı olur ve 3 kat mail gider. DB tek kaynak.
 *
 * Koruma katmanları (hepsi DB'de):
 *   1. alerts_enabled kapalı mı
 *   2. ardışık hata eşiği doldu mu
 *   3. günlük tavan aşıldı mı  ← Hostinger limitini korur
 *   4. aynı hata için cooldown içinde mi
 */
export class Alerter {
  private transporter: Transporter | null = null;
  private verified = false;

  constructor(private db: Db) {}

  private getTransport(): Transporter | null {
    if (!env.smtp.enabled) return null;
    if (this.transporter) return this.transporter;

    this.transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: { user: env.smtp.user, pass: env.smtp.pass },
      pool: true,
      maxConnections: 1,      // Hostinger eşzamanlı bağlantıyı sevmez
      maxMessages: 50,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return this.transporter;
  }

  /** Açılışta SMTP doğrulaması — yanlış şifreyi ilk hatada değil şimdi öğren */
  async verify(): Promise<boolean> {
    const t = this.getTransport();
    if (!t) { log.info("SMTP kapalı"); return false; }
    try {
      await t.verify();
      this.verified = true;
      log.info("SMTP bağlantısı doğrulandı", { host: env.smtp.host, port: env.smtp.port });
      return true;
    } catch (err) {
      log.error("SMTP doğrulaması başarısız — bildirimler gitmeyecek", { err });
      return false;
    }
  }

  /**
   * Bildirim gönder. DB izin vermezse sessizce çıkar.
   * Bu fonksiyon ASLA throw etmez — bildirim hatası botu durduramaz.
   */
  async send(a: AlertInput): Promise<boolean> {
    try {
      const fp = fingerprint("alert", a.key);
      const decision = await this.db.shouldAlert(fp, a.severity);

      if (!decision.should_send) {
        log.debug("Bildirim bastırıldı", { key: a.key, reason: decision.reason });
        return false;
      }

      const to = decision.to_email;
      if (!to) {
        log.warn("Bildirim alıcısı tanımsız (bot_settings.alert_email boş)");
        return false;
      }

      const subject = `[${LABELS[a.severity]}] ${a.title}`;
      const html = renderHtml(a, decision.suppressed);
      const text = renderText(a);

      const t = this.getTransport();
      if (!t) {
        await this.db.recordAlert({
          fingerprint: fp, subject, body: text, severity: a.severity,
          to, delivered: false, smtpError: "SMTP kapalı",
        });
        return false;
      }

      try {
        await t.sendMail({ from: env.smtp.from, to, subject, text, html });
        await this.db.recordAlert({
          fingerprint: fp, subject, body: text, severity: a.severity,
          to, delivered: true, meta: { suppressed: decision.suppressed },
        });
        log.info("Bildirim gönderildi", { key: a.key, severity: a.severity, to });
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Bildirim gönderilemedi", { key: a.key, err });
        // delivered=false → cooldown başlamaz, sonraki denemede tekrar gider
        await this.db.recordAlert({
          fingerprint: fp, subject, body: text, severity: a.severity,
          to, delivered: false, smtpError: msg,
        });
        return false;
      }
    } catch (err) {
      // Bildirim katmanı hiçbir koşulda botu çökertmez
      log.error("Alerter beklenmeyen hata", { err });
      return false;
    }
  }

  /** Sık kullanılan kısayollar */
  async critical(key: string, title: string, details?: Record<string, unknown>, error?: unknown) {
    return this.send({ severity: "critical", key, title, details, error });
  }
  async warning(key: string, title: string, details?: Record<string, unknown>, error?: unknown) {
    return this.send({ severity: "warning", key, title, details, error });
  }
  async info(key: string, title: string, details?: Record<string, unknown>) {
    return this.send({ severity: "info", key, title, details });
  }

  /**
   * Watchdog'un kuyruğa attığı uyarıları gerçekten gönder.
   *
   * Watchdog pg_cron ile Supabase içinde çalışıyor ve SMTP'ye
   * erişemiyor. Bot ayağa kalktığında bekleyenleri buradan atıyor.
   * Bastırma mantığı atlanır — bunlar zaten DB'de eşiği geçmiş.
   */
  async flushPending(): Promise<number> {
    try {
      const pending = await this.db.undeliveredAlerts(10);
      if (pending.length === 0) return 0;

      const t = this.getTransport();
      if (!t) return 0;

      let sent = 0;
      for (const a of pending) {
        if (!a.sent_to) continue;
        try {
          await t.sendMail({
            from: env.smtp.from,
            to: a.sent_to,
            subject: a.subject,
            text: a.body ?? "",
            html: renderHtml({
              severity: a.severity, key: a.fingerprint,
              title: a.subject.replace(/^\[[^\]]+\]\s*/, ""),
              details: { "Kaynak": "Watchdog (bot dışı kontrol)" },
            }, 0) + `<pre style="font-size:12px;color:#374151;padding:0 20px">${
              esc(a.body ?? "")}</pre>`,
          });
          await this.db.markAlertDelivered(a.id, true);
          sent++;
        } catch (err) {
          await this.db.markAlertDelivered(
            a.id, false, err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (sent > 0) log.info("Bekleyen uyarılar gönderildi", { count: sent });
      return sent;
    } catch (err) {
      log.warn("Bekleyen uyarı gönderimi başarısız", { err });
      return 0;
    }
  }

  async close(): Promise<void> {
    this.transporter?.close();
    this.transporter = null;
  }
}
