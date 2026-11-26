# DartScan 🎯

Website, die eine Dartscheibe mit der Handykamera beobachtet und die Punkte automatisch zählt.
Spielmodi 301 / 501 / 701 (Double- oder Single-Out), lokal mit 1–8 Spielern oder online gegeneinander per Raum-Code.
Dazu Statistik (Heatmap, Felder, Average, Doppelquote …), Konten per Google oder E-Mail und eine Weltrangliste.

## Projektstruktur

| Datei | Inhalt |
|---|---|
| `server.js` | Express-Server (liefert die Seite aus) + WebSocket unter `/ws` |
| `rooms.js` | Online: Räume mit Freunden, Zufallsgegner, öffentliche Turniere, Live-Kamerabild, Melden, Aufgabe bei Abwesenheit |
| `links.js` | Geräte koppeln: Fernseher/Laptop als Bildschirm, zweites Handy als 2. Kamera |
| `auth.js` | Prüft die Firebase-Anmeldung auf dem Server (ohne Zusatzpaket) |
| `reports.js` | Meldungen per Telegram (oder Discord/Brevo) + Übersicht `/admin/meldungen` |
| `public/game.js` | Spiellogik X01 (Bust, Double-Out, Undo, Checkout-Vorschläge), läuft im Browser und auf dem Server |
| `public/board.js` | Scheibengeometrie (mm), Punkteberechnung, SVG-Scheibe |
| `public/boardfinder.js` | Findet die Scheibe über die Farbringe (Auto-Kalibrierung, Nachführen), Kameramodell |
| `public/detector.js` | Pfeilerkennung (Bild- und Farbvergleich, Pfeilspitze, Zoom, Pfeile-gezogen-Erkennung) |
| `public/fuse.js` | Verrechnet die Treffer von zwei Kameras zu einem genaueren Punkt |
| `public/app.js` | Spiel-Oberfläche, Kamera, automatische Scheibensuche, Lernpfad, Online-Client |
| `public/link.js` | Geräte koppeln (Handy-Seite), Bildschirm-Modus, 2.-Kamera-Modus |
| `public/learn.js` | Lernpfad: 32 Übungen in 5 Stufen (Karte), Fortschritt im Konto |
| `public/qr.js` | QR-Code für den Koppel-Code am Bildschirm |
| `public/ui.js` | Navigation, Statistik-Seite, Weltrangliste, Profil/Anmeldung |
| `public/stats.js` | Statistik erfassen und auswerten |
| `public/account.js` | Konten, Cloud-Speicher (Statistik + Lernpfad), Rangliste (Firebase) |
| `public/speech.js` / `voicecmd.js` | Ansage, Sprachbefehle („Hey DartScan“) |
| `public/scrollrail.js` | Scroll-Streifen rechts (normal wischen, ohne das Kamerabild zu berühren) |
| `public/firebase-config.js` | **Deine Firebase-Zugangsdaten** (nicht im ZIP, bleibt bei dir) |
| `firestore.rules` | Sicherheitsregeln für die Datenbank (in Firebase einfügen) |
| `test/` | `npm test`: Regeln, Erkennung, Pfeile ziehen, Online, Turniere, Kopplung, 2 Kameras, Anmeldung, Lernpfad, Sprachbefehle |

## Neu in Version 2.2

- **Immer die neueste Version:** Safari am iPhone hat offene Tabs mit der alten Version weiterlaufen lassen. Jetzt lädt die Seite alle Dateien mit Versionskennung, fragt alle 5 Minuten und beim Zurückkehren in die App nach einer neuen Version und lädt sich dann selbst neu (im laufenden Spiel erscheint nur ein Hinweis „Jetzt laden“). Die Version steht unten in den Einstellungen.
- **Im Spiel unter der Kamera nur noch ein Knopf: „Kamera neu starten“.** Alles andere (Kalibrieren, Zoom, Debug, Einstellungen, Kamera aus) gibt es nur unter **Kamera einrichten**.
- **Auto-Zoom nur digital:** Die Optik des Handys wird nie automatisch umgeschaltet (das ließ das Bild hängen und verstellte Schärfe/Belichtung).
- **20 per Neigung des Handys:** Statt einer Kamera-Lageschätzung wird nur die Neigung aus dem Lagesensor genutzt. Das ist robuster und braucht keine Brennweite.
- **Diagnose am Laptop:** `…/?bildschirm&diagnose` öffnen und das Handy koppeln. Dann zeigt der Laptop alle Messwerte des Handys (Kalibrierung, 20-Richtung, Zoom, Sensor, Rechenzeit, Mikro).

## Neu in Version 2.1

- **Raster nicht mehr verdreht (18 auf der 20):** Die gespeicherte Kalibrierung vom letzten Mal wird beim Kamerastart nicht mehr blind übernommen. Die Scheibe wird frisch gesucht und verglichen. Wo die 20 ist, sagt der **Lagesensor des Handys** (die Scheibe hängt mit der 20 nach oben), auch wenn das Handy schräg steht. Ohne Sensor gilt „oben im Bild“. Hat man die 20 beim Einrichten selbst angetippt, merkt sich die App das.
- **Automatische Kalibrierung legt das Raster sauber auf**, auch direkt im Spiel, ohne vorher in den Kalibriermodus zu gehen.
- **Automatischer Zoom:** Die Kamera zoomt von selbst auf die Scheibe (mit Platz für herausragende Pfeile). Das ist genauer und braucht weniger Rechenleistung. Nie mitten in einer Aufnahme. Ist die Scheibe länger verloren, zoomt die App heraus und sucht neu.
- **Im Spiel nichts mehr verstellbar:** Wischen über das Kamerabild scrollt einfach die Seite. Zoom-Regler und Debug gibt es nur noch unter **Kamera einrichten**.
- **Spracheingabe hört dauerhaft zu:** Während der eigenen Ansage ist das Mikro kurz aus (sonst hört es sich selbst und bleibt auf Android hängen). Eine hängende Erkennung wird automatisch neu gestartet, doppelte Ergebnisse werden ignoriert.
- **Auto-Weiter nach „Weiter“ von Hand:** Drückt man „Weiter“, nachdem die Pfeile schon gezogen sind, wartet die Erkennung nicht mehr auf ein Ziehen, das nie kommt. Auto-Weiter klappt in der nächsten Aufnahme sofort wieder.
- **Laptop/Fernseher:**
  - Würfe am Laptop korrigieren (Pfeil anklicken), fehlende Pfeile eintragen, „Weiter“ und „Zurück“.
  - **Letzte Aufnahmen** aller Spieler werden angezeigt, die letzte ist auch korrigierbar. Das Trefferbild zeigt nach dem Weiterschalten noch die letzten Pfeile.
- **Weniger Leistung nötig:** Das Kamerabild wird direkt angezeigt statt 60× pro Sekunde umgezeichnet. Für die Bewegungserkennung reicht ein kleines Bild, das große wird nur geholt, wenn es ruhig ist. Im Test braucht das Spiel rund **halb so viel Rechenzeit** wie vorher, bei gleicher Erkennung.
- **Sounds:** Treffer-Einschlag (Triple/Double heller), Fanfare bei 180, Ton bei 100+, „Überworfen“, Sieg, Spielerwechsel. Abschaltbar in den Einstellungen.
- **Scrollleiste** rechts ganz schlicht: eine dünne Linie.

## Neu in Version 2.0

- **Ansage-Knopf** (Lautsprecher) neben „Sprachbefehle“: Die Ansage startet immer aus und wird mit einem Tipp eingeschaltet. Erst dieser Tipp erlaubt dem Browser den Ton, deshalb ging sie früher erst nach dem Aus- und Einschalten.
- **„Hey DartScan“** wird jetzt nach Klang erkannt: auch „Dartskind“, „Dartskin“, „Darts kann“, „Dart Skin“, „Darts Kinn“, „Datscan“ … „Das kann“ oder „Dort kann“ lösen dagegen nicht aus.
- **Automatische Scheibensuche ohne Knopf:** Kamera an, dann wird die Scheibe gesucht und sofort übernommen. Im Spiel gibt es kein Kalibrieren von Hand mehr, nur „Scheibe neu suchen“. Wird die Scheibe verloren, sucht die App selbst weiter. Von Hand geht es nur noch unter **Kamera einrichten → Manuell**.
- **Pfeile ziehen → nächster Spieler:** Das klappt jetzt auch nach 1 oder 2 Pfeilen. Es bleibt nicht mehr hängen, wenn nach dem Ziehen kleine Spuren bleiben (Löcher, Fasern), das Handy wackelt, sich das Licht ändert oder jemand beim Ziehen vor der Scheibe steht. Zieht man die Pfeile einzeln, entsteht kein falscher Extra-Pfeil mehr.
- **Konto nötig** für Online, Turniere und Lernpfad. Das lokale Spiel geht weiterhin ohne Anmeldung. Der Server prüft die Anmeldung selbst.
- **Online gegen Fremde:**
  - **Zufallsgegner:** 301 oder 501, sofort los, wer anfängt wird ausgelost.
  - **Öffentliche Turniere:** Blitz 4 Spieler / 501-Cup 8 Spieler / Masters 16 Spieler. Sie starten automatisch, wenn das Feld voll ist, oder nach der Wartezeit mit Freilosen. Es gibt keinen Turnierleiter: Wer ca. 75 s offline ist oder 2½ Minuten nicht wirft, verliert das Match.
- **Fair Play:**
  - Online sieht man das **Live-Bild der Scheibe des Gegners**, inklusive Markierung des erkannten Treffers.
  - **Melden** schickt dir eine Telegram-Nachricht mit den letzten Kamerabildern und dem Spielverlauf.
  - Fremde dürfen keine Pfeile des Gegners ändern.
- **Lernpfad als Karte:**
  - 32 Übungen statt 15, jede Stufe endet mit einer Prüfung.
  - Neu dabei: 19er-Training, Shanghai, Doppel und Triple rund um die Uhr, Bob’s 27, 301 Single-Out, Finishes über 100 …
  - Der Fortschritt wird im Konto gespeichert und auf allen Geräten abgeglichen. Alter Fortschritt bleibt erhalten.
- **Geräte koppeln:**
  - Fernseher oder Laptop zeigt Spielstand, Kamerabild und Trefferbild groß an, auf Wunsch auch mit Ansage über die Lautsprecher des Fernsehers. Gekoppelt wird per 5-stelligem Code oder QR-Code.
  - Ein **zweites Handy als 2. Kamera**: Beide erkennen den Pfeil, das Haupt-Handy verrechnet beide Blickwinkel. Im Test (40 Würfe knapp neben Drähten) lagen beide Kameras zusammen deutlich öfter richtig als jede allein.

### Einstellungen auf Render (Environment)

| Variable | Wofür | Muss? |
|---|---|---|
| `FIREBASE_PROJECT_ID` | Projekt für die Anmeldeprüfung (Standard `dart-1f6be`) | nein |
| `TELEGRAM_BOT_TOKEN` | Meldungen als Telegram-Nachricht mit Bildern aufs Handy (empfohlen) | für Nachrichten ja |
| `TELEGRAM_CHAT_ID` | Deine Chat-ID (zeigt dir die Übersicht `/admin/meldungen` an) | für Telegram ja |
| `DISCORD_WEBHOOK_URL` | Alternative: Meldungen in einen Discord-Kanal | nein |
| `BREVO_API_KEY`, `REPORT_TO`, `REPORT_FROM` | Alternative: Meldungen per E-Mail über Brevo | nein |
| `ADMIN_KEY` | Passwort für die Übersicht `https://…/admin/meldungen?key=DEIN_PASSWORT` | nein |
| `BANNED_UIDS` | Gesperrte Konten (Konto-IDs aus der Meldung, mit Komma getrennt) | nein |
| `GOOGLE_TTS_KEY`, `TTS_VOICE` | Natürliche Server-Stimme (wie bisher) | nein |

**Meldungen aufs Handy (Telegram) einrichten:**
1. In Telegram den Chat **@BotFather** öffnen, `/newbot` schreiben, einen Namen und einen Benutzernamen (endet auf `bot`) wählen.
2. BotFather schickt dir einen **Token** (sieht aus wie `123456:ABC-…`). Auf Render bei deinem Dienst: **Environment → Add Environment Variable** → `TELEGRAM_BOT_TOKEN` = der Token. Zusätzlich `ADMIN_KEY` = ein Passwort deiner Wahl. Speichern (Render startet neu).
3. In Telegram deinen neuen Bot öffnen und **Start** tippen (bzw. `/start` schreiben).
4. Im Browser `https://DEINE-ADRESSE/admin/meldungen?key=DEIN_PASSWORT` öffnen. Dort steht dein Name mit einer Zahl (deine Chat-ID). Auf Render `TELEGRAM_CHAT_ID` = diese Zahl eintragen und speichern.
5. Seite neu öffnen und **Test-Nachricht senden** tippen – die Nachricht kommt in Telegram an.

Sicherheit: Den Bot-Token und `ADMIN_KEY` nur auf Render eintragen, nie in eine Datei auf GitHub. Ist der Token doch einmal irgendwo sichtbar geworden: in @BotFather `/revoke` und den neuen Token auf Render eintragen. Gesendet wird nur an die eingetragene Chat-ID – schreibt ein Fremder deinem Bot, bekommt er nichts.

Normale E-Mail (Gmail usw.) geht auf Render im Gratis-Plan nicht, weil Render die Mail-Ports sperrt.

Wichtig: Turniere, Räume und Kopplungen liegen im Speicher des Servers. Bei einem Redeploy gehen laufende Spiele verloren, deshalb am besten nicht während eines Turniers hochladen.

## Lokal starten

```bash
npm install
npm start          # http://localhost:3000
npm test
npm run bench     # Härtetest (dauert ~1 Minute)
```

Die Kamera funktioniert im Browser nur über **HTTPS** oder `localhost`.
Am Handy also am einfachsten direkt die Render-Adresse verwenden.

## Auf Render.com veröffentlichen

1. Ordner in ein GitHub-Repo hochladen.
2. Auf Render **New → Web Service** wählen und das Repo verbinden.
3. Als Build Command `npm install` eintragen, als Start Command `npm start`.
4. Fertig. Render liefert automatisch HTTPS, die WebSockets laufen über dieselbe Adresse.

Hinweis: Beim Gratis-Plan schläft der Dienst nach etwa 15 Minuten ohne Nutzung ein.
Der erste Aufruf danach dauert dann rund 30 Sekunden.

## Konten & Weltrangliste einrichten (Firebase, kostenlos)

Ohne diesen Schritt läuft alles, die Statistik wird dann aber nur auf dem jeweiligen Gerät gespeichert.

1. Geh auf [console.firebase.google.com](https://console.firebase.google.com) und klicke auf **Projekt hinzufügen**. Name z. B. `dartscan`, Google Analytics brauchst du nicht.
2. **Web-App anlegen:** Klicke in der Projektübersicht auf das Symbol **`</>`** (Web), gib einen Namen ein und klicke auf **App registrieren**. Firebase zeigt dir dann einen Block `const firebaseConfig = { apiKey: …, … }`.
3. Öffne `public/firebase-config.js`. Ersetze `window.FIREBASE_CONFIG = null;` durch `window.FIREBASE_CONFIG = { … }` mit genau diesen Werten aus Schritt 2.
4. **Anmeldung aktivieren:** Gehe links auf **Build → Authentication → Jetzt starten → Anmeldemethode**.
   - Aktiviere **Google** und wähle eine Support-E-Mail.
   - Aktiviere **E-Mail-Adresse/Passwort**.
5. **Domain freigeben:** Unter **Authentication → Einstellungen → Autorisierte Domains → Domain hinzufügen** trägst du deine Render-Adresse ein, z. B. `dartscan.onrender.com` (ohne `https://`).
6. **Datenbank anlegen:** Gehe auf **Build → Firestore Database → Datenbank erstellen**.
   - Wähle als Standort **europe-west3 (Frankfurt)** und den **Produktionsmodus**.
   - Öffne danach den Reiter **Regeln**, ersetze den Inhalt durch den Inhalt der Datei `firestore.rules` und klicke auf **Veröffentlichen**.
7. Lade die geänderte `firebase-config.js` auf GitHub hoch. Render baut die Seite neu, danach erscheinen unter **Profil** die Anmeldeknöpfe.

Die Firebase-Werte aus Schritt 2 sind nicht geheim, sie dürfen öffentlich auf GitHub stehen. Geschützt werden die Daten durch die Regeln aus Schritt 6: Jeder darf nur seine eigene Statistik lesen und schreiben. Die Rangliste ist für alle lesbar.

**Statistik:**
- Würfe werden im lokalen Spiel für den als **„Ich“** markierten Spieler erfasst, online für dich selbst.
- Was du ohne Anmeldung gespielt hast, wird beim ersten Anmelden automatisch ins Konto übernommen.

**Weltrangliste:**
- Es gibt die Wertungen Average, 180er, höchstes Finish und Siege.
- In die Average-Wertung kommt man erst ab 99 Pfeilen, damit eine einzelne Glücksaufnahme nicht reicht.
- Die Werte werden vom Handy aus gemeldet und von den Regeln nur auf Plausibilität geprüft. Für eine Hobby-Rangliste reicht das, fälschungssicher wie ein Turniersystem ist es nicht.

## Ansage & Sprachbefehle

**Ansage:** Die App wählt automatisch die natürlichste deutsche Stimme, die das Gerät hat. Wählen und testen kannst du sie unter ⚙ → Ansage.
- Am natürlichsten klingen in Edge „Katja (Natural)“, auf dem iPhone die „Premium“-Stimmen und in Chrome „Google Deutsch“.
- Jede Zahl wird als eigene Ansage gesprochen, damit z. B. „3“ nicht als „dritter“ vorgelesen wird.

**Noch natürlicher (optional): Google-Neural-Stimme über den Server**
1. Öffne die [Google Cloud Console](https://console.cloud.google.com) und wähle dein Firebase-Projekt. Unter **APIs & Dienste → Bibliothek** suchst du „Cloud Text-to-Speech API“ und klickst auf **Aktivieren**. Dafür ist ein Rechnungskonto nötig, die ersten 1 Million Zeichen pro Monat sind aber kostenlos. Dart-Ansagen sind kurz und werden zwischengespeichert.
2. Unter **APIs & Dienste → Anmeldedaten → Anmeldedaten erstellen → API-Schlüssel** legst du einen Schlüssel an. Beschränke ihn am besten auf die Text-to-Speech-API.
3. Auf **Render** gehst du in deinem Dienst auf **Environment → Add Environment Variable**: `GOOGLE_TTS_KEY` = dein Schlüssel. Optional setzt du `TTS_VOICE`, z. B. `de-DE-Neural2-B` (männlich) oder `de-DE-Neural2-C` (weiblich).
4. Nach dem Neustart erscheint unter ⚙ → Stimme „Google Neural (Server)“.

**Ansage:** Tippe im Spiel oben links auf den Lautsprecher (**Ansage aus/an**).

**Sprachbefehle:** Tippe im Spiel oben auf **Sprachbefehle** und erlaube das Mikrofon. Das funktioniert in Chrome und Edge. Unter dem Knopf siehst du live, was verstanden wurde.
- **Korrigieren nach Wert:** „Korrigiere 4 auf 18“. Mehrere geht auch: „Korrigiere 4 auf 18. Korrigiere 13 auf 1“ oder „Korrigiere 4 auf 18 und 13 auf 1“.
- **Nach Position:** „Korrigiere den zweiten Pfeil auf Doppel 16“ oder „Korrigiere auf Triple 20“ (ändert den letzten Pfeil).
- **Ohne „Dartcounter“:** Korrekturen mit „korrigiere … auf …“ klappen direkt, ohne Aktivierungswort. Aus der Entfernung ist das deutlich zuverlässiger. Abschalten kannst du das unter ⚙ → Sprachbefehle.
- **Mit „Dartcounter“:** Sobald das Wort erkannt wird, kommt ein Signalton. Danach hast du 8 Sekunden für den Befehl, z. B. „weiter“, „zurück“ oder „korrigiere …“.
- Ist schon weitergeschaltet, wird automatisch die vorherige Aufnahme korrigiert.
- Töne: aufsteigend heißt „ich höre“ bzw. „erledigt“, absteigend heißt „nicht verstanden“.

**Tipps für die Entfernung:**
- Leg das Handy mit dem Mikrofon (meist unten am Gerät) Richtung Abwurflinie.
- Schalt laute Musik leiser.
- Am zuverlässigsten ist ein Bluetooth-Headset oder ein Ohrhörer mit Mikrofon. Den nimmt der Browser automatisch als Mikrofon.

**Die Erkennung lernt aus Korrekturen:** Erkennt die App die Spitze immer wieder ein Stück zu weit hinten (oder vorne), gleicht sie das nach einigen Korrekturen selbst aus. Beim neuen Kalibrieren wird das zurückgesetzt.

**Erkennungsprotokoll:** Unter ⚙ → „Erkennungsprotokoll herunterladen“ bekommst du eine Datei mit den Bildausschnitten aller korrigierten Pfeile. Damit lässt sich die Erkennung an echten Bildern verbessern.

## So stellst du das Handy auf

- Stell das Handy **seitlich oder schräg unterhalb** der Scheibe auf, z. B. auf ein Stativ 40–80 cm daneben. Frontal von vorne ist ungünstig, weil man die Pfeile dann nicht von der Seite sieht.
- Tippe auf **„⤢ Scheibe“**, dann zoomt die Kamera so, dass die Scheibe das Bild ausfüllt. Mehr Pixel pro Feld bedeuten eine genauere Erkennung. Du kannst auch mit zwei Fingern zoomen und mit einem Finger verschieben.
- Sorge für **gleichmäßiges Licht**, etwa einen LED-Ring.
- Leichtes Verrutschen ist **kein Problem mehr** (siehe unten).

## Kalibrieren – automatisch

Sobald die Kamera läuft, sucht die Seite die Scheibe selbst über die roten und grünen Ringe, ganz ohne Knopf, und legt ein gelbes Raster darüber.
- Unter **Kamera einrichten**: Steht die **20** nicht oben, tippst du auf die echte 20, dann dreht sich das Raster. **Fertig** schließt die Einrichtung.
- Findet die Automatik die Scheibe gar nicht (z. B. bei schlechtem Licht), gibt es nur dort **Manuell**: die 4 Punkte am äußeren Doppelring antippen (20, 6, 3, 11). Die Punkte rasten automatisch an den Ringen ein.
- Im Spiel und im Lernpfad gibt es nur **Scheibe neu suchen**.

## Automatisches Nachführen

Die Seite prüft laufend anhand der Farbringe, ob die Scheibe noch dort ist, wo sie sein sollte.
Verrutscht das Handy, auch wenn ein Pfeil beim Einschlag dagegen stößt, schiebt sie das Raster automatisch nach.
Bereits gezählte Pfeile bleiben dabei richtig. In den Tests klappt das bei Verschiebungen von 2 bis über 25 Pixel.
Wird die Scheibe gar nicht mehr gefunden (Handy umgefallen, verdeckt), pausiert die Erkennung, bis die Scheibe wieder sichtbar ist.

## Zoom

- Echter Kamera-Zoom, wo das Handy ihn unterstützt (viele Android-Handys in Chrome). Sonst wird aus dem Full-HD-Bild ausgeschnitten.
- Die Kalibrierung wird beim Zoomen automatisch umgerechnet, du musst nicht neu kalibrieren.

## Wie die Erkennung funktioniert

1. **Kameramodell:** Aus der Kalibrierung berechnet die Seite, wo das Handy relativ zur Scheibe steht. Damit weiß sie, in welche Richtung ein Pfeil im Bild aus der Scheibe ragt und wo seine Spitze sein muss.
2. **Bildvergleich nach jedem Wurf:** Sobald das Bild wieder ruhig ist, wird es mit dem Bild vor dem Wurf verglichen, und zwar Helligkeit **und** Farbe. Dabei werden herausgerechnet:
   - **Erschütterung:** Die Bewegung des Bildes beim Einschlag wird auf Bruchteile eines Pixels genau gemessen (Verschiebung und leichte Drehung). Das Raster wird gleich mit nachgezogen.
   - **Belichtung und Farbstich:** Ausgleich in Bildbereichen, ohne dass ein Pfeil oder Flight die Korrektur verfälscht.
3. **Pfeil zusammensetzen:** Spitze, Barrel und Flight erscheinen oft als getrennte Flecken, etwa wenn ein Teil vor einem gleichfarbigen Feld steckt. Teile, die auf einer gemeinsamen Linie in Pfeilrichtung liegen, werden zu einem Pfeil zusammengefasst.
4. **Unplausibles verwerfen:** Was nicht auf der Scheibe beginnt (Halterungen, Wand, Zahlenring), dünne Kantenreste, zu lange oder zu breite Flecken. Die Statuszeile zeigt dann „Ignoriert (…)“.
5. **Spitze:** Das Ende Richtung Scheibe ist die Spitze. Von dort folgt die Seite der dünnen Stahlspitze weiter bis zu ihrem Ende, auch wenn die Spitze kaum Kontrast hat.
6. Die Spitze wird in mm auf der Scheibe umgerechnet. Daraus ergeben sich Sektor und Ring.
7. Nach 3 Pfeilen (oder Bust) wartet die Seite, bis die Scheibe wieder leer ist, und schaltet dann weiter.

**Härtetest** (`npm run bench`, mit `EDGE=1` gezielt knapp neben Drähten): 5 Handy-Positionen, je 4 Aufnahmen à 3 Pfeile plus Leerversuche nur mit Erschütterung.
- **97 %** der Würfe richtig gezählt, die Spitze liegt im Median **1,2–1,4 mm** daneben.
- **0 Fehlalarme**.
- Liegt der Treffer nur 0,3–2,5 mm neben einem Draht, sind es je nach Kameraposition 73–82 %. Die letzten 1–2 mm einer Stahlspitze über einem gleichfarbigen Draht sind für eine einzelne Kamera schlicht nicht sichtbar.

**Genauigkeitsanzeige:** Nach dem Kalibrieren zeigt die App, wie genau diese Kameraposition messen kann. Das hängt von Blickwinkel, Abstand und Zoom ab. Bei „grob“ oder „ok“ gibt sie einen konkreten Tipp.
- Ein Blickwinkel von 30–50° zur Scheibe ist ideal.
- Sehr flach von der Seite (über 55°) wird es ungenau.

## Einstellungen (⚙)

- **Empfindlichkeit:** Bei Fehlerkennungen den Regler nach rechts schieben, bei übersehenen Pfeilen nach links.
- **Pfeilspitze:** Am besten auf „Automatisch“ lassen, die Richtung kommt aus dem Kameramodell.
- **Belichtung & Fokus fixieren** (Standard: an): Verhindert Helligkeitssprünge zwischen den Würfen. Das funktioniert vor allem mit Android und Chrome, das iPhone ignoriert es.
- **Misses automatisch zählen** (Standard: aus): Ohne Häkchen wird alles außerhalb des Doppelrings ignoriert. Einen echten Fehlwurf trägst du mit **Miss** ein.
- **Raster automatisch nachführen** ist standardmäßig an.
- Die Auswertung läuft mit bis zu 1280 Pixeln. Ist das Handy dafür zu langsam, regelt die App die Auflösung automatisch herunter.
- Außerdem lässt sich das automatische Weiterschalten ein- und ausschalten (die Ansage über den Lautsprecher-Knopf im Spiel).
- **Debug** zeigt die erkannte Veränderung rot im Kamerabild.

## Grenzen (1 Kamera)

- Pfeile, die ganz knapp (1–3 mm) an einem Draht stecken, können ins Nachbarfeld fallen.
- Steckt ein neuer Pfeil aus Sicht der Kamera direkt hinter einem älteren, ist er verdeckt und wird nicht erkannt.

Korrigieren geht schnell: Tippe auf den Pfeil in der Anzeige, dann wählst du das richtige Feld oder löschst den Pfeil.
Für **Miss** und Abpraller gibt es eigene Tasten.

## Fehlersuche

In der Browser-Konsole liefert `DartScanDebug.detector.lastAnalyze` die Details der letzten Auswertung: Größe und Länge des Flecks, Front und Spitze in Pixeln.

## Online-Modus

- **Mit Freunden:** Ein Spieler erstellt einen Raum und teilt den 4-stelligen Code oder den Einladungslink. Der Host startet.
- **Zufallsgegner:** „Gegner suchen“ – sobald jemand anderes auch sucht, geht es los. Revanche nur, wenn beide zustimmen.
- **Turniere:** siehe oben.

Jeder spielt an seiner eigenen Scheibe mit eigenem Handy. Nur das Handy des Spielers, der gerade dran ist, zählt mit. Die anderen sehen die Würfe und das Kamerabild live. Wenn die Verbindung abreißt, verbindet sich die Seite automatisch neu und der Spielstand bleibt erhalten.

## Geräte koppeln

1. Am Fernseher oder Laptop DartScan öffnen → **Geräte koppeln** → **Dieses Gerät ist der Bildschirm**. Direkt geht es auch mit `…/?bildschirm` (Lesezeichen am Fernseher).
2. Am Handy **Geräte koppeln** (oder im Spiel das Bildschirm-Symbol) → den Code eingeben. Alternativ den QR-Code am Bildschirm mit der Handykamera scannen.
3. Fertig: Der Bildschirm zeigt Spielstand, Treffer und Kamerabild. Mit „Ton an“ sagt er auch die Punkte an.

**Zweite Kamera:** Am zweiten Handy **Geräte koppeln → Dieses Handy ist die 2. Kamera**, auf die andere Seite der Scheibe stellen, Code am Haupt-Handy eingeben. Die Scheibe wird automatisch erkannt. Treffer, die beide Kameras sehen, werden verrechnet; in der Anzeige steht dann „2 Kameras“.

## Neu: Dartcoins, Lernmodus, Turniere

- **Dartcoins** (`public/coins.js`): 1 Runde = 1 Coin (lokales Spiel, Online-Spiel, Lektion, Turnier-Match). In der Testphase unbegrenzt (`UNLIMITED = true`). Später auf `false` setzen und `earnByVideo()` mit dem Werbepartner verbinden.
- **Lernpfad** (`public/learn.js`): 32 Übungen in 5 Stufen als Karte, mit Zielen, Sternen und Coach-Tipps. Funktioniert mit Kamera oder Eingabe von Hand. Fortschritt im Konto.
- **Öffentliche Turniere** (`rooms.js`): gegen Fremde, K.-o.-System mit Freilosen, Start automatisch, Aufgabe bei Abwesenheit.
- **Sprachbefehle wie bei Siri:** „Hey DartScan, korrigiere 4 auf 18“, „Hey DartScan, weiter“, „Hey DartScan, zurück“. Nach „Hey DartScan“ allein kommt ein Signalton, dann darf der Befehl folgen.
- **Scroll-Streifen** (`public/scrollrail.js`): rechts, normal wischen.
- Tests: `npm test` (inkl. Lernmodus und Turniere).
