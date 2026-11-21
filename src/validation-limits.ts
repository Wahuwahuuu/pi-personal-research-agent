/** Application-wide lifetime allowance; counters survive account changes and upgrades. */
export const VALIDATION_LIMITS=Object.freeze({requests:1500,input:12000000,output:2000000} as const);
