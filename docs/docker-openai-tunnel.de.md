# wacli-me mit Docker und OpenAI Secure MCP Tunnel

Diese Compose-Konfiguration startet den wacli.me-MCP-Server und den offiziellen
OpenAI-Tunnel-Client in einem privaten Docker-Netzwerk. Der Server und die
Tunnel-Statusseite sind nur über `127.0.0.1` des Hosts erreichbar; der MCP-Port
ist nicht öffentlich erreichbar.

Der Tunnel wird an genau einen wacli.me-Mandanten gebunden. Der Tunnel-Client
setzt dessen Bearer-Token intern, bevor er den MCP-Server aufruft.
Die Compose-Datei verwendet das offizielle Tunnel-Client-Image, gepinnt auf
Version `v0.0.15` und seinen Image-Digest. Aktuelle Produkt- und Netzwerkanforderungen
stehen in der [offiziellen OpenAI-Dokumentation zum Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## 1. Lokale Konfiguration anlegen

Im Repository-Verzeichnis:

```bash
cp .env.example .env
chmod 600 .env
mkdir -p stores logs
```

Unter Linux trägst du in `.env` für `WACLI_UID` und `WACLI_GID` die Werte von
`id -u` und `id -g` ein. So kann der Container die eingebundenen Datenordner
beschreiben und du kannst die Dateien weiter mit deinem Benutzer bearbeiten.
Bei Docker Desktop kannst du zunächst die Vorgabewerte stehen lassen.

Erstelle eine leere Mandantenliste und speichere sie als
`config/tenants.json`:

```json
{
  "tenants": []
}
```

Die Datei ist von Git ausgeschlossen.

## 2. WhatsApp-Konto lokal verknüpfen

Starte zunächst nur den lokalen Server:

```bash
docker compose -f docker-compose.tunnel.yml up -d --build wacli-me
```

Öffne [http://localhost:8787/connect](http://localhost:8787/connect) und
verknüpfe dein WhatsApp-Konto über den QR-Code. Wähle dort, ob der Server
Nachrichten senden darf; die Checkbox ist standardmäßig aktiviert. Der Server
legt den Mandanten und dessen zufälligen Token in `config/tenants.json` an.

Übernimm den Token dieses Mandanten in `.env` als `WACLI_ME_TENANT_TOKEN`.
Bewahre denselben Wert in `config/tenants.json` auf. Aktiviere `allowSend` dort
nur, wenn der MCP-Server auch Nachrichten senden dürfen soll.

Diese Compose-Konfiguration setzt `WACLI_ME_DEFAULT_PLAN` standardmäßig auf
`self-hosted`; der neue Mandant erhält damit nicht das gehostete Free-Limit.
Self-hosted-Mandanten behalten ihre Historie und werden bei Inaktivität nicht
gelöscht. Verwalte Speicherplatz und Aufbewahrung auf diesem Rechner selbst.

## 3. OpenAI-Tunnel eintragen

Erstelle einen Tunnel in den
[OpenAI Platform Tunnel-Einstellungen](https://platform.openai.com/settings/organization/tunnels)
und ordne ihn dem gewünschten ChatGPT-Workspace zu. Setze dessen ID in
`CONTROL_PLANE_TUNNEL_ID` in `.env`.

Setze `CONTROL_PLANE_API_KEY` auf den Runtime-Key mit Tunnels **Read + Use**.
Ein Admin-Key mit **Manage** ist für den laufenden Tunnel-Client nicht geeignet.

## 4. Server und Tunnel starten

```bash
docker compose -f docker-compose.tunnel.yml up -d --build
docker compose -f docker-compose.tunnel.yml ps
docker compose -f docker-compose.tunnel.yml logs --tail=100 -f tunnel-client
```

Die Tunnel-Statusseite ist unter
[http://localhost:8092/ui](http://localhost:8092/ui) erreichbar. Ändere
`TUNNEL_UI_PORT` in `.env`, wenn der Port belegt ist.

Verbinde anschließend in ChatGPT unter **Plugins → Entwickler-App → Connection
→ Tunnel** die neue Tunnel-ID. Der Tunnel-Client setzt den
wacli.me-Mandanten-Token lokal; richte für diese Verbindung keine zusätzliche
MCP-Bearer-Authentifizierung ein.

Der Tunnel-Client benötigt ausgehendes HTTPS zu OpenAI. Es sind keine
eingehenden Firewall-Regeln oder öffentliche MCP-Adresse nötig.

## Betrieb

### WhatsApp-Verbindung und Push-Mitteilungen

Der Docker-Aufbau verwendet standardmäßig `WACLI_SYNC_MODE=on-request`.
Die WhatsApp-Verbindung startet erst bei einem MCP-Tool-Aufruf. Vor der
Antwort holt wacli den Offline-Rückstand ab und aktualisiert den lokalen
Suchindex. Währenddessen verwendet die verknüpfte Sitzung den `quiet`-Status,
der kein „available“ sendet. Nach dem letzten Aufruf trennt sie sich nach
`WACLI_SYNC_IDLE_MS` (standardmäßig 5 Sekunden). Der erste Aufruf nach einer
Pause kann daher etwas länger dauern.

Setze in `.env` `WACLI_SYNC_IDLE_MS=0`, wenn direkt nach jeder Antwort getrennt
werden soll. Für dauerhafte Synchronisierung setze `WACLI_SYNC_MODE=continuous`;
auch dann bleibt der WhatsApp-Status auf `quiet`. WhatsApp entscheidet selbst,
wie Benachrichtigungen auf dem iPhone zugestellt werden; `quiet` reduziert das
Risiko, kann das Verhalten aber nicht für jede Plattform garantieren.

Änderungen an `WACLI_SYNC_MODE` oder `WACLI_SYNC_IDLE_MS` werden so aktiv:

```bash
docker compose -f docker-compose.tunnel.yml up -d --build wacli-me
```

Nach Änderungen an den OpenAI-Tunnel-Einträgen den Tunnel-Client neu erstellen:

```bash
docker compose -f docker-compose.tunnel.yml up -d --force-recreate tunnel-client
```

Stoppen:

```bash
docker compose -f docker-compose.tunnel.yml down
```

Der Tunnel-Client erreicht den MCP-Server über das Compose-Netzwerk. Der lokale
Host-Port ist auf `127.0.0.1` beschränkt. Für weitere WhatsApp-Konten verwende
einen eigenen Tunnel-Client mit passendem Mandanten-Token und einer eigenen
Tunnel-ID.
