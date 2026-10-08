export type ProductKind = "physical" | "reservation";

export interface Product {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  priceCents: number;
  category: string;
  kind: ProductKind;
  features: string[];
  /** Used by the product illustration. */
  finish: "oak" | "slate" | "studio";
  units: number;
}

export const PRODUCTS: Product[] = [
  {
    slug: "halden-one",
    name: "Halden One",
    tagline: "A bookshelf speaker that fills the room, not the shelf.",
    description:
      "Hand-finished oak cabinet, a 5\" paper-cone woofer and a silk-dome tweeter tuned in our Asheville workshop. Wi-Fi, Bluetooth and a proper analog input, because some records deserve a cable.",
    priceCents: 24900,
    category: "speakers",
    kind: "physical",
    features: ["Solid oak cabinet", "60 W class-D amp", "Wi-Fi, Bluetooth 5.3, line in", "2-year warranty"],
    finish: "oak",
    units: 1,
  },
  {
    slug: "halden-pair",
    name: "Halden Pair",
    tagline: "Two Halden Ones, matched and paired for true stereo.",
    description:
      "A factory-matched pair of Halden One speakers with grain-matched cabinets and a stereo link that is set up before it leaves the bench. The way they were meant to be heard.",
    priceCents: 44900,
    category: "bundles",
    kind: "physical",
    features: ["Grain-matched oak cabinets", "Pre-linked stereo pair", "Braided speaker link cable", "Save $49 vs. two singles"],
    finish: "slate",
    units: 2,
  },
  {
    slug: "halden-studio-reservation",
    name: "Studio Listening Session",
    tagline: "Reserve an hour in our listening room.",
    description:
      "Bring your own records or a playlist and hear the full range in a treated room. The $50 deposit holds your slot and comes off any speaker you order within 30 days.",
    priceCents: 5000,
    category: "reservations",
    kind: "reservation",
    features: ["60 minutes, up to 3 guests", "Deposit credited to any order", "Free reschedule up to 48 h before"],
    finish: "studio",
    units: 0,
  },
];

export const STOREFRONT_SLUGS = ["halden-one", "halden-pair"];

export function getProduct(slug: string): Product | undefined {
  return PRODUCTS.find((p) => p.slug === slug);
}

export function formatPrice(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** "halden-one,halden-one,halden-pair" -> [{ slug, qty }] in first-seen order. */
export function parseSkuList(raw: string | string[] | undefined): { slug: string; qty: number }[] {
  const joined = Array.isArray(raw) ? raw.join(",") : raw ?? "";
  const counts = new Map<string, number>();
  for (const part of joined.split(",")) {
    const slug = part.trim();
    if (!slug || !getProduct(slug)) continue;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  return Array.from(counts, ([slug, qty]) => ({ slug, qty }));
}
