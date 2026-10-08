import { useEffect } from "react";
import { viewItem } from "../src/common/analytics";

export default function ConsentNotice({ product }: { product: "lamp" | "lamp-pair" | null }) {
  useEffect(() => {
    if (product) viewItem(product);
  }, [product]);
  return null;
}
