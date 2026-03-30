const BASE_PRICES: Record<string, string> = {
  tAAPL: "191.25",
  tBOND: "102.40",
  tNVDA: "893.50"
};

export class PriceService {
  getReferencePrice(symbol: string): string {
    return BASE_PRICES[symbol] ?? "100.00";
  }

  getAll(): Record<string, string> {
    return { ...BASE_PRICES };
  }
}

