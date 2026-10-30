# DartScan 🎯

Website, die eine Dartscheibe mit der Handykamera beobachtet und die Punkte automatisch zählt.
Spielmodi 301 / 501 / 701 (Double- oder Single-Out), lokal mit 1–8 Spielern oder online gegeneinander per Raum-Code.
Dazu Statistik (Heatmap, Felder, Average, Doppelquote …), Konten per Google oder E-Mail und eine Weltrangliste.

## Projektstruktur

| Datei | Inhalt |
|---|---|
| `server.js` | Express-Server (liefert die Seite aus) + WebSocket unter `/ws` |
| `rooms.js` | Online-Räume: Code, Beitreten, Wiederverbinden, Spielzüge prüfen |
| `public/game.js` | Spiellogik X01 (Bust, Double-Out, Undo, Checkout-Vorschläge), läuft im Browser und auf dem Server |
| `public/board.js` | Scheibengeometrie (mm), Punkteberechnung, SVG-Scheibe |
| `public/boardfinder.js` | Findet die Scheibe über die Farbringe (Auto-Kalibrierung, Nachführen), Kameramodell |
| `public/detector.js` | Pfeilerkennung (Bild- und Farbvergleich, Pfeilspitze, Zoom) |
| `public/app.js` | Spiel-Oberfläche, Kamera, Kalibrierung, Online-Client |
| `public/ui.js` | Navigation, Statistik-Seite, Weltrangliste, Profil/Anmeldung |
| `public/stats.js` | Statistik erfassen und auswerten |
| `public/account.js` | Konten, Cloud-Speicher, Rangliste (Firebase) |
| `public/firebase-config.js` | **Hier deine Firebase-Zugangsdaten eintragen** |
| `firestore.rules` | Sicherheitsregeln für die Datenbank (in Firebase einfügen) |
| `test/test.js` | 61 Tests: Regeln, Online, Auto-Kalibrierung, Verrutschen, 3D-Pfeile, Statistik |
| `test/synth.js` | Erzeugt künstliche Kamerabilder (Scheibe + 3D-Pfeile) für die Tests |
| `test/bench.js` | Härtetest: realistische Szene mit Zahlenring, Metall-Halterungen, Erschütterung, Belichtungsschwankung, echter Pfeilform und 5 Handy-Positionen |

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

**Sprachbefehle:** Tippe im Spiel oben links auf **Sprachbefehle** und erlaube das Mikrofon. Das funktioniert in Chrome und Edge. Unter dem Knopf siehst du live, was verstanden wurde.
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

Tippe auf **Kalibrieren**. Die Seite sucht die Scheibe selbst über die roten und grünen Ringe und legt ein gelbes Raster darüber.
- Steht die **20** nicht oben, tippst du einfach auf die echte 20, dann dreht sich das Raster.
- Mit **Fertig** übernimmst du die Kalibrierung.
- Findet die Automatik die Scheibe nicht (z. B. bei schlechtem Licht), wechselst du auf **Manuell** und tippst die 4 Punkte am äußeren Doppelring an: 20, 6, 3 und 11. Die Punkte rasten danach automatisch an den Ringen ein.

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
- Außerdem lassen sich die Sprachansage und das automatische Weiterschalten ein- und ausschalten.
- **Debug** zeigt die erkannte Veränderung rot im Kamerabild.

## Grenzen (1 Kamera)

- Pfeile, die ganz knapp (1–3 mm) an einem Draht stecken, können ins Nachbarfeld fallen.
- Steckt ein neuer Pfeil aus Sicht der Kamera direkt hinter einem älteren, ist er verdeckt und wird nicht erkannt.

Korrigieren geht schnell: Tippe auf den Pfeil in der Anzeige, dann wählst du das richtige Feld oder löschst den Pfeil.
Für **Miss** und Abpraller gibt es eigene Tasten.

## Fehlersuche

In der Browser-Konsole liefert `DartScanDebug.detector.lastAnalyze` die Details der letzten Auswertung: Größe und Länge des Flecks, Front und Spitze in Pixeln.

## Online-Modus

Ein Spieler erstellt einen Raum und teilt den 4-stelligen Code oder den Einladungslink.
Jeder spielt an seiner eigenen Scheibe mit eigenem Handy.
Nur das Handy des Spielers, der gerade dran ist, zählt mit. Die anderen sehen die Würfe live.
Wenn die Verbindung abreißt, verbindet sich die Seite automatisch neu und der Spielstand bleibt erhalten.
