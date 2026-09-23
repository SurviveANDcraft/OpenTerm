// ===================================================================
//  Device emulation presets for browser panes
// ===================================================================
//
// Each preset carries the device's real CSS viewport (logical px, portrait),
// its device-pixel-ratio and a user-agent class. Picking one re-creates the
// pane's child webview with that UA + a small shim script (devicePixelRatio,
// touch points, platform), and glues it to a scaled-down device frame drawn
// in the pane — so a page lays out exactly as it would on the real hardware.

export type UaClass = "ios-phone" | "ios-tablet" | "android-phone" | "android-tablet" | "desktop";
export type FrameKind = "phone" | "tablet" | "fold" | "desktop";
export type Cutout = "island" | "notch" | "punch" | "none";

export interface Device {
  id: string;
  name: string;
  group: string;
  /** Portrait CSS viewport, in logical px. */
  w: number;
  h: number;
  dpr: number;
  ua: UaClass;
  frame: FrameKind;
  cutout: Cutout;
  /** Physical screen corner radius, in device px — drives the frame's rounding. */
  radius: number;
}

const IOS = "18_5";
const SAFARI = "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const CHROME = "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0";

export function userAgentFor(d: Device): string | null {
  switch (d.ua) {
    case "ios-phone":
      return `Mozilla/5.0 (iPhone; CPU iPhone OS ${IOS} like Mac OS X) ${SAFARI}`;
    case "ios-tablet":
      return `Mozilla/5.0 (iPad; CPU OS ${IOS} like Mac OS X) ${SAFARI}`;
    case "android-phone":
      return `Mozilla/5.0 (Linux; Android 15; ${androidModel(d)}) ${CHROME} Mobile Safari/537.36`;
    case "android-tablet":
      return `Mozilla/5.0 (Linux; Android 15; ${androidModel(d)}) ${CHROME} Safari/537.36`;
    default:
      return null; // keep the real desktop UA
  }
}

function androidModel(d: Device): string {
  return d.name.replace(/\s*\(.*\)\s*$/, "");
}

/** Injected before any page script: makes feature detection agree with the UA. */
export function deviceShim(d: Device): string {
  const touch = d.ua !== "desktop";
  const platform =
    d.ua === "ios-phone" ? "iPhone" : d.ua === "ios-tablet" ? "iPad" : touch ? "Linux armv8l" : "Win32";
  return `(function(){try{
    var D=${d.dpr}, T=${touch ? 1 : 0};
    Object.defineProperty(window,'devicePixelRatio',{get:function(){return D;},configurable:true});
    Object.defineProperty(navigator,'platform',{get:function(){return ${JSON.stringify(platform)};},configurable:true});
    Object.defineProperty(navigator,'maxTouchPoints',{get:function(){return T?5:0;},configurable:true});
    if(T){
      window.ontouchstart=null;
      try{window.Touch=window.Touch||function(){};window.TouchEvent=window.TouchEvent||function(){};}catch(e){}
      try{Object.defineProperty(navigator,'userAgentData',{get:function(){return undefined;},configurable:true});}catch(e){}
    }
  }catch(e){}})()`;
}

export const RESPONSIVE: Device = {
  id: "responsive",
  name: "Responsive",
  group: "",
  w: 0,
  h: 0,
  dpr: 1,
  ua: "desktop",
  frame: "desktop",
  cutout: "none",
  radius: 0,
};

/** Real logical viewports (portrait) — the numbers Safari/Chrome report on the
 *  hardware itself, not the marketing pixel counts. */
export const DEVICES: Device[] = [
  // ---- iPhone ----
  d("iphone-16-pro-max", "iPhone 16 Pro Max", "iPhone", 440, 956, 3, "ios-phone", "phone", "island", 55),
  d("iphone-16-pro", "iPhone 16 Pro", "iPhone", 402, 874, 3, "ios-phone", "phone", "island", 55),
  d("iphone-16-plus", "iPhone 16 Plus", "iPhone", 430, 932, 3, "ios-phone", "phone", "island", 55),
  d("iphone-16", "iPhone 16", "iPhone", 393, 852, 3, "ios-phone", "phone", "island", 55),
  d("iphone-15", "iPhone 15 / 14 Pro", "iPhone", 393, 852, 3, "ios-phone", "phone", "island", 55),
  d("iphone-13", "iPhone 14 / 13", "iPhone", 390, 844, 3, "ios-phone", "phone", "notch", 47),
  d("iphone-13-mini", "iPhone 13 mini", "iPhone", 375, 812, 3, "ios-phone", "phone", "notch", 44),
  d("iphone-se", "iPhone SE (3rd gen)", "iPhone", 375, 667, 2, "ios-phone", "phone", "none", 4),
  // ---- Android phones ----
  d("pixel-9-pro", "Pixel 9 Pro", "Android phone", 448, 992, 2.63, "android-phone", "phone", "punch", 42),
  d("pixel-8", "Pixel 8", "Android phone", 412, 915, 2.63, "android-phone", "phone", "punch", 38),
  d("pixel-7a", "Pixel 7a", "Android phone", 412, 892, 2.6, "android-phone", "phone", "punch", 32),
  d("galaxy-s24-ultra", "Galaxy S24 Ultra", "Android phone", 384, 824, 3.75, "android-phone", "phone", "punch", 20),
  d("galaxy-s24", "Galaxy S24", "Android phone", 360, 780, 3, "android-phone", "phone", "punch", 36),
  d("galaxy-a54", "Galaxy A54", "Android phone", 360, 800, 3, "android-phone", "phone", "punch", 28),
  d("xiaomi-13", "Xiaomi 13", "Android phone", 393, 873, 2.75, "android-phone", "phone", "punch", 34),
  // ---- Foldables ----
  d("zfold6-cover", "Galaxy Z Fold 6 · cover", "Foldable", 360, 892, 2.63, "android-phone", "phone", "punch", 30),
  d("zfold6-open", "Galaxy Z Fold 6 · unfolded", "Foldable", 690, 850, 2.63, "android-tablet", "fold", "punch", 24),
  d("zfold5-cover", "Galaxy Z Fold 5 · cover", "Foldable", 344, 882, 2.63, "android-phone", "phone", "punch", 30),
  d("zfold5-open", "Galaxy Z Fold 5 · unfolded", "Foldable", 673, 841, 2.63, "android-tablet", "fold", "punch", 24),
  d("zflip6", "Galaxy Z Flip 6", "Foldable", 360, 880, 3.4, "android-phone", "phone", "punch", 36),
  d("pixel-fold", "Pixel Fold · unfolded", "Foldable", 701, 841, 2.63, "android-tablet", "fold", "punch", 24),
  // ---- Tablets ----
  d("ipad-pro-13", "iPad Pro 13\"", "Tablet", 1024, 1366, 2, "ios-tablet", "tablet", "none", 22),
  d("ipad-air-11", "iPad Air 11\"", "Tablet", 820, 1180, 2, "ios-tablet", "tablet", "none", 20),
  d("ipad-10", "iPad (10th gen)", "Tablet", 820, 1180, 2, "ios-tablet", "tablet", "none", 18),
  d("ipad-mini", "iPad mini", "Tablet", 744, 1133, 2, "ios-tablet", "tablet", "none", 20),
  d("galaxy-tab-s9", "Galaxy Tab S9", "Tablet", 753, 1205, 2.4, "android-tablet", "tablet", "none", 16),
  d("surface-pro", "Surface Pro 9", "Tablet", 912, 1368, 2, "desktop", "tablet", "none", 10),
  // ---- Desktop ----
  d("laptop-13", "Laptop 13\"", "Desktop", 1280, 800, 2, "desktop", "desktop", "none", 6),
  d("laptop-15", "Laptop 15\"", "Desktop", 1440, 900, 2, "desktop", "desktop", "none", 6),
  d("desktop-1080", "Desktop 1080p", "Desktop", 1920, 1080, 1, "desktop", "desktop", "none", 6),
  d("desktop-1440", "Desktop 1440p", "Desktop", 2560, 1440, 1, "desktop", "desktop", "none", 6),
];

function d(
  id: string,
  name: string,
  group: string,
  w: number,
  h: number,
  dpr: number,
  ua: UaClass,
  frame: FrameKind,
  cutout: Cutout,
  radius: number
): Device {
  return { id, name, group, w, h, dpr, ua, frame, cutout, radius };
}

export function deviceById(id: string | undefined | null): Device | null {
  if (!id || id === RESPONSIVE.id) return null;
  return DEVICES.find((x) => x.id === id) ?? null;
}
