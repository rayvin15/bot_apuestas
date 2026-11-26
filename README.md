# Tipster AI para Telegram

## Configuración

Instala las dependencias con `npm ci`. Configura `TELEGRAM_TOKEN`, `FOOTBALL_API_KEY`, `GEMINI_API_KEY`, `MONGO_URI` y `ADMIN_TELEGRAM_USER_ID` en `.env` o en las variables del servicio. Si todavía no sabes tu ID, inicia el bot con `npm start` y envía `/mi_id` en un chat privado. Añade ese número a `ADMIN_TELEGRAM_USER_ID` y reinicia el proceso.

## Pronósticos y seguimiento

- Envía `/start`, elige una competición y analiza un partido para obtener un borrador. Si faltan resultados recientes para alguno de los equipos, el bot guarda **Sin pick**.
- Publica antes del inicio con `/cuota ID_DEL_PARTIDO 1.85 Nombre de la fuente` o con el botón **Publicar sin cuota**. El bot registra la cuota, la fuente introducida y la hora de publicación.
- **Auditar** liquida ganador (1X2), más/menos de 2.5 goles y ambos marcan usando el marcador a los 90 minutos. Los partidos aplazados siguen pendientes y los cancelados o adjudicados se anulan. Los mercados antiguos que requieren otra regla aparecen en **Pendientes** para revisión.
- **Banca** incluye en la efectividad todos los aciertos y fallos guardados. El saldo y el rendimiento en unidades se calculan con las cuotas registradas. **Exportar CSV** incluye las cuotas, sus fuentes y las horas en UTC.
- **Radar** muestra las alineaciones disponibles y la hora de actualización de la ficha. Las bajas aparecen como desconocidas porque la ficha del partido ofrece alineaciones. [Datos de partido en Football-Data](https://docs.football-data.org/general/v4/match.html)

Ejecuta las pruebas con `npm test`.
