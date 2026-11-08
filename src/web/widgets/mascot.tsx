// The robot face in the sidebar: RoboBuddy draws its moods on a canvas inside the head.
import { RoboBuddy } from '@x-tech-laboratories/robobuddy';
import { useEffect, useRef } from 'react';

import { lasting_mood, MASCOT_SCREEN, MOMENT_MILLISECONDS } from '../mascot.ts';
import { on_moment, use_workbench } from '../lib/workbench.ts';

export function Mascot() {
    const canvas = useRef<HTMLCanvasElement>(null);
    const face = useRef<RoboBuddy | null>(null);
    const state = use_workbench();
    const mood = lasting_mood(state);

    useEffect(() => {
        const buddy = new RoboBuddy(canvas.current!);
        buddy.begin(MASCOT_SCREEN.width, MASCOT_SCREEN.height, buddy.frameRate);
        buddy.setMood(mood);
        buddy.start();
        face.current = buddy;
        // A run that ends plays its mood over the lasting one for a few seconds.
        const stop = on_moment((moment) => buddy.setMood(moment, { for: MOMENT_MILLISECONDS }));
        return () => {
            stop();
            buddy.stop();
            face.current = null;
        };
    }, []);

    useEffect(() => {
        face.current?.setMood(mood);
    }, [mood]);

    return (
        <div className="mascot-foot">
            <svg className="mascot" viewBox="13.5 16.5 37 30.5" role="img" aria-label="CODEX">
                <g className="mascot-body" transform="translate(0 2)">
                    <rect x="18" y="25" width="28" height="20" rx="6" />
                    <rect x="13.5" y="31" width="5" height="8" rx="2" />
                    <rect x="45.5" y="31" width="5" height="8" rx="2" />
                    <rect x="30.5" y="19" width="3" height="7" />
                    <circle cx="32" cy="17.5" r="3" />
                </g>
                <circle className="mascot-light" cx="32" cy="19.5" r="1.2" />
                <rect className="mascot-screen" x="19" y="28" width="26" height="18" rx="5" />
                <foreignObject x="19" y="28" width="26" height="18">
                    <canvas ref={canvas} className="mascot-face" />
                </foreignObject>
            </svg>
            <p className="run-status">{state.status}</p>
        </div>
    );
}
