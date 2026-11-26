// The assistant's face: RoboBuddy draws its moods on a canvas laid over the screen of the robot head of CODEX's icon.

// ── Imports ──────────────────────────────────────────────────────────────────

import { RoboBuddy } from "@x-tech-laboratories/robobuddy";
import { useEffect, useRef } from "react";

import { mascot_screen, mascot_screen_box, mascot_view, moment_ms, screen_placement, type MascotMood } from "./mascot.ts";

// ── Mascot ───────────────────────────────────────────────────────────────────

// A moment, such as happy after a reply, plays over the lasting mood for a few seconds; a new moment needs a new key.
export function Mascot({ mood, moment }: { mood: MascotMood; moment: { mood: MascotMood; key: number } | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const face = useRef<RoboBuddy | null>(null);

  useEffect(() => {
    let buddy: RoboBuddy;
    try {
      buddy = new RoboBuddy(canvas.current!);
    } catch {
      // Without a 2D canvas, such as in a test page, the head is drawn with an empty screen.
      return;
    }
    buddy.begin(mascot_screen.width, mascot_screen.height, buddy.frameRate);
    buddy.setMood(mood);
    buddy.start();
    face.current = buddy;
    return () => {
      buddy.stop();
      face.current = null;
    };
    // The face is made once; the effects below follow the mood.
  }, []);

  useEffect(() => {
    face.current?.setMood(mood);
  }, [mood]);

  useEffect(() => {
    if (moment) face.current?.setMood(moment.mood, { for: moment_ms });
  }, [moment]);

  const view = `${mascot_view.x} ${mascot_view.y} ${mascot_view.width} ${mascot_view.height}`;
  const box = mascot_screen_box;
  // The canvas lies over the drawing at its real size, so RoboBuddy fills it at the display's pixel density.
  return (
    <div className="mascot" role="img" aria-label={`CODEX, ${moment?.mood ?? mood}`}>
      <svg viewBox={view} aria-hidden="true">
        <g className="mascot-body" transform="translate(0 2)">
          <rect x="18" y="25" width="28" height="20" rx="6" />
          <rect x="13.5" y="31" width="5" height="8" rx="2" />
          <rect x="45.5" y="31" width="5" height="8" rx="2" />
          <rect x="30.5" y="19" width="3" height="7" />
          <circle cx="32" cy="17.5" r="3" />
        </g>
        <circle className="mascot-light" cx="32" cy="19.5" r="1.2" />
        {/* The face's screen is black in both themes, as the robot's artwork is, so the eyes read the same everywhere. */}
        <rect x={box.x} y={box.y} width={box.width} height={box.height} rx="5" fill="#000" />
      </svg>
      <canvas ref={canvas} className="mascot-face" style={screen_placement()} />
    </div>
  );
}
