// The background jobs in the order they are tried: events the user is waiting on first, upkeep after.
import type { BackgroundOptions } from './background.js';
import type { Settings } from './settings.js';

export type BackgroundStep<Values extends Settings = Settings> = (settings: Values, options: BackgroundOptions) => Promise<boolean>;

export const JOB_CLASSES = ['reactive', 'maintenance'] as const;
export type JobClass = (typeof JOB_CLASSES)[number];

export type Job<Values extends Settings = Settings> = {
    name: string;
    jobClass: JobClass;
    step: BackgroundStep<Values>;
};

// Run the first job that has work, reactive jobs before maintenance ones, and return its name, or null when none did.
export async function runNextJob<Values extends Settings>(jobs: readonly Job<Values>[], settings: Values, options: BackgroundOptions): Promise<string | null> {
    for (const jobClass of JOB_CLASSES) {
        for (const job of jobs) {
            if (job.jobClass === jobClass && (await job.step(settings, options))) {
                return job.name;
            }
        }
    }
    return null;
}
