function inspectDeepFrozenPlainData(
  value: unknown,
  active: Set<object>,
  completed: Set<object>,
): boolean {
  if (value === null || typeof value !== "object") {
    return ["string", "number", "boolean"].includes(typeof value) || value === null;
  }
  if (completed.has(value)) return true;
  if (active.has(value)) return false;
  active.add(value);
  try {
    if (!Object.isFrozen(value)) return false;

    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return false;
    } else if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }

    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      return false;
    }
    const keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined
        || !Object.hasOwn(lengthDescriptor, "value")
        || lengthDescriptor.value !== keys.length - 1
      ) return false;
      let expectedIndex = 0;
      for (const key of keys) {
        if (key === "length") continue;
        if (key !== String(expectedIndex)) return false;
        expectedIndex += 1;
      }
    }

    for (const key of keys) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
        || !inspectDeepFrozenPlainData(descriptor.value, active, completed)
      ) return false;
    }
    completed.add(value);
    return true;
  } finally {
    active.delete(value);
  }
}

export function isDeepFrozenPlainData(value: unknown): boolean {
  try {
    return inspectDeepFrozenPlainData(value, new Set(), new Set());
  } catch {
    return false;
  }
}
