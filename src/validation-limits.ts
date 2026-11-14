/** Application-wide lifetime allowance; counters survive account changes and upgrades. */
export const VALIDATION_LIMITS=Object.freeze({requests:900,input:6000000,output:1000000} as const);
