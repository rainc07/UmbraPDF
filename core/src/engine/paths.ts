/** Resolve a bundled vendor asset relative to the page (works under any host/base path). */
export const vendorUrl = (p: string): string => new URL(`vendor/${p}`, document.baseURI).href;
