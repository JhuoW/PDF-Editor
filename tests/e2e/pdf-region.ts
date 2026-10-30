import type { Page } from '@playwright/test';

/** Reveal PDF coordinates without changing zoom or the expected export geometry. */
export async function revealPDFRegion(page: Page, top: number, bottom: number) {
  await page.locator('canvas.page-canvas').first().evaluate((canvas, region) => {
    const viewer = canvas.closest<HTMLElement>('.pdf-viewer-container');
    if (!viewer) return;
    const sheet = canvas.getBoundingClientRect(), viewport = viewer.getBoundingClientRect();
    if (sheet.top + region.bottom > viewport.bottom - 20) viewer.scrollTop += sheet.top + region.bottom - viewport.bottom + 20;
    else if (sheet.top + region.top < viewport.top + 20) viewer.scrollTop -= viewport.top + 20 - sheet.top - region.top;
  }, { top, bottom });
}
