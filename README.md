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
| `public/detector.js` | Pfeilerkennung (Homographie, Bilddifferenz, Pfeilspitze) |
| `public/app.js` | Oberfläche, Kamera, Kalibrierung, Online-Client |
| `test/test.js` | 34 Tests: Punkte, Spielregeln, Erkennung mit künstlichen Bildern, Online-Räume |

## Lokal starten

```bash
npm install
npm start          # http://localhost:3000
npm test
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

- Stell das Handy **seitlich oder schräg unterhalb** der Scheibe auf, etwa 40–80 cm entfernt, mit Stativ oder Halterung. Die ganze Scheibe muss im Bild sein.
- Die Pfeile sollen im Bild **länglich** zu sehen sein, also nicht frontal von vorne. Dann findet die Erkennung die Spitze am schmalen Ende.
- Sorge für **gleichmäßiges Licht**, etwa einen LED-Ring um die Scheibe. Vermeide Schatten von Personen auf der Scheibe.
- Das Handy darf sich nach dem Kalibrieren **nicht mehr bewegen**.

## Kalibrieren

Tippe nacheinander auf den **äußeren Rand des Doppelrings**, jeweils mittig bei **20 (oben), 6 (rechts), 3 (unten) und 11 (links)**.
Danach liegt ein gelbes Raster über dem Bild, das genau auf den Drähten sitzen sollte.
Du kannst die Punkte noch ziehen, eine Lupe hilft beim genauen Setzen.

## Wie die Erkennung funktioniert

1. Nach dem Kalibrieren rechnet eine Homographie jeden Bildpunkt in Scheiben-Koordinaten (mm) um.
2. Die Seite merkt sich ein Referenzbild. Ist das Bild nach einem Wurf etwa 0,3 s ruhig, vergleicht sie es mit der Referenz.
3. Der größte veränderte Fleck ist der neue Pfeil. Eine Hauptachsen-Analyse liefert die Ausrichtung. Die Spitze ist das schmale Ende, denn der Flight ist breit.
4. Aus Winkel und Abstand vom Bull ergeben sich Sektor und Ring, und die Seite zählt mit.
5. Nach 3 Pfeilen (oder bei Bust) wartet die Seite, bis die Scheibe wieder leer aussieht. Dann geht es automatisch zum nächsten Spieler weiter.

## Einstellungen (⚙)

- **Empfindlichkeit:** Bei Fehlerkennungen durch Licht oder Schatten den Regler nach rechts schieben.
- **Pfeilspitze:** Steht die Kamera so, dass die Spitze immer unten (oder oben) im Bild liegt, stell das fest ein. Das ist zuverlässiger als „Automatisch".
- Außerdem lassen sich die Sprachansage und das automatische Weiterschalten ein- und ausschalten.
- **Debug** zeigt die erkannte Veränderung rot im Kamerabild.

## Grenzen (1 Kamera)

- Pfeile knapp an einem Draht können ins Nachbarfeld fallen.
- Ein Pfeil, der einen anderen verdeckt, wird eventuell nicht erkannt.

Korrigieren geht schnell: Tippe auf den Pfeil in der Anzeige, dann wählst du das richtige Feld oder löschst den Pfeil.
Für **Miss** und Abpraller gibt es eigene Tasten.

## Online-Modus

Ein Spieler erstellt einen Raum und teilt den 4-stelligen Code oder den Einladungslink.
Jeder spielt an seiner eigenen Scheibe mit eigenem Handy.
Nur das Handy des Spielers, der gerade dran ist, zählt mit. Die anderen sehen die Würfe live.
Wenn die Verbindung abreißt, verbindet sich die Seite automatisch neu und der Spielstand bleibt erhalten.
