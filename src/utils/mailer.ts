import { Resend } from 'resend';
import { config } from '../config/env';
import { logger } from './logger';

const resend = new Resend(config.RESEND_API_KEY);

export interface AppointmentEmailData {
    adminEmail: string;
    clientName: string;
    city: string;
    date: string;
    time: string;
    appointmentType: string;
    phone?: string;
    propertyReference?: string;
    address?: string;
}

export async function sendAppointmentNotification(data: AppointmentEmailData): Promise<void> {
    if (!config.RESEND_API_KEY) {
        logger.warn('RESEND_API_KEY no configurada — notificación de cita omitida');
        return;
    }

    const typeLabels: Record<string, string> = {
        venta_joya: 'Venta de Joya',
    };

    const typeLabel = typeLabels[data.appointmentType] ?? data.appointmentType;

    const details = [
        `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Cliente</td><td style="padding:8px 0;font-weight:600;font-size:14px;">${data.clientName}</td></tr>`,
        `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Ciudad de Envío</td><td style="padding:8px 0;font-weight:600;font-size:14px;">${data.city}</td></tr>`,
        `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Fecha</td><td style="padding:8px 0;font-weight:600;font-size:14px;">${data.date}</td></tr>`,
        `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Hora</td><td style="padding:8px 0;font-weight:600;font-size:14px;">${data.time}</td></tr>`,
        `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Tipo</td><td style="padding:8px 0;font-weight:600;font-size:14px;">${typeLabel}</td></tr>`,
        data.phone ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">WhatsApp</td><td style="padding:8px 0;font-weight:600;font-size:14px;">${data.phone}</td></tr>` : '',
        data.propertyReference ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Joya / Producto</td><td style="padding:8px 0;font-weight:600;font-size:14px;">${data.propertyReference}</td></tr>` : '',
        data.address ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Referencia Joya</td><td style="padding:8px 0;font-weight:600;font-size:14px;">${data.address}</td></tr>` : '',
    ].filter(Boolean).join('');

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#10b981;padding:24px 32px;">
            <p style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">📅 Nueva cita agendada</p>
            <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Agendada automáticamente vía WhatsApp</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              ${details}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px;color:#9ca3af;font-size:12px;">
            Este correo fue generado automáticamente por el bot de WhatsApp.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    try {
        await resend.emails.send({
            from: 'Citas Bot <onboarding@resend.dev>',
            to: data.adminEmail,
            subject: `Nueva cita: ${typeLabel} — ${data.clientName} (${data.date} ${data.time})`,
            html,
        });
        logger.info(`Notificación de cita enviada a ${data.adminEmail}`);
    } catch (err: any) {
        // El error de email no debe bloquear la confirmación al cliente
        logger.error(`Error enviando notificación de cita:`, err?.message ?? err);
    }
}
