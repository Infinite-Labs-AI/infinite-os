// P2-4: conversion names in plain words for the screens ("checkout starts, purchases and leads"). The names themselves
// (`begin_checkout`, `purchase`, `lead`) stay the plan's data and what the user edits.

const CONVERSION_WORDS: Readonly<Record<string, string>> = {
  purchase: "purchases",
  begin_checkout: "checkout starts",
  lead: "leads",
  sign_up: "sign-ups",
  signup: "sign-ups",
  start_trial: "trial starts",
  trial: "trial starts",
  booking: "bookings",
  schedule: "bookings",
  subscribe: "subscriptions",
  add_to_cart: "add-to-cart",
  view_item: "product views"
}

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("")
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
}

/** "checkout starts, purchases and leads"; an unknown name with its underscores as spaces. */
export function conversionWords(names: readonly string[]): string {
  return listWords([...new Set(names.map((name) => CONVERSION_WORDS[name] ?? name.replace(/[_-]+/g, " ")))])
}
