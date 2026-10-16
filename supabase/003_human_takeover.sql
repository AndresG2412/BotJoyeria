-- Coexistencia (número de la joyería en la app WhatsApp Business + bot):
-- cuando alguien de la joyería contesta desde el celular, el bot se aparta de ese chat
-- hasta `human_until`. Nula = el bot atiende normalmente.
--
-- Es aditivo e idempotente. El rol bot_joyeria ya puede leer y escribir la columna
-- (sus permisos son sobre la tabla completa).

alter table bot.sessions add column if not exists human_until timestamptz;
