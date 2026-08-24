/// Count-plus-noun strips read "1 pages" without this. Regular -s only; nothing here is irregular.
export const plural = (count: number, noun: string, many = `${noun}s`) => count === 1 ? noun : many;
