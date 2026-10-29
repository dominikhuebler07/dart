# DartScan 🎯

Website, die eine Dartscheibe mit der Handykamera beobachtet und die Punkte automatisch zählt.
Spielmodi 301 / 501 / 701 (Double- oder Single-Out), lokal mit 1–8 Spielern oder online gegeneinander per Raum-Code.

## Projektstruktur

| Datei | Inhalt |
|---|---|
| `server.js` | Express-Server (liefert die Seite aus) + WebSocket unter `/ws` |
| `rooms.js` | Online-Räume: Code, Beitreten, Wiederverbinden, Spielzüge prüfen |
| `public/game.js` | Spiellogik X01 (Bust, Double-Out, Undo, Checkout-Vorschläge), läuft im Browser und auf dem Server |
| `public/board.js` | Scheibengeometrie (mm), Punkteberechnung, SVG-Scheibe |
| `public/boardfinder.js` | Findet die Scheibe über die Farbringe (Auto-Kalibrierung, Nachführen), Kameramodell |
| `public/detector.js` | Pfeilerkennung (Bild- und Farbvergleich, Pfeilspitze, Zoom) |
| `public/app.js` | Oberfläche, Kamera, Kalibrierung, Online-Client |
| `test/test.js` | 51 Tests: Regeln, Online, Auto-Kalibrierung, Verrutschen, 3D-Pfeile aus 4 Handy-Positionen |
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

**Härtetest** (`npm run bench`): 5 Handy-Positionen, je 4 Aufnahmen à 3 Pfeile plus Leerversuche nur mit Erschütterung, 4 Durchläufe.
- **97,5 %** der Würfe richtig gezählt, die Spitze liegt im Median **3,4 mm** daneben.
- **0 Fehlalarme** in 160 Leerversuchen.
- Bei doppelt so starker Erschütterung sind es noch 95 %.

## Einstellungen (⚙)

- **Empfindlichkeit:** Bei Fehlerkennungen den Regler nach rechts schieben, bei übersehenen Pfeilen nach links.
- **Pfeilspitze:** Am besten auf „Automatisch“ lassen, die Richtung kommt aus dem Kameramodell.
- **Belichtung & Fokus fixieren** (Standard: an): Verhindert Helligkeitssprünge zwischen den Würfen. Das funktioniert vor allem mit Android und Chrome, das iPhone ignoriert es.
- **Misses automatisch zählen** (Standard: aus): Ohne Häkchen wird alles außerhalb des Doppelrings ignoriert. Einen echten Fehlwurf trägst du mit **Miss** ein.
- **Raster automatisch nachführen** ist standardmäßig an.
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
