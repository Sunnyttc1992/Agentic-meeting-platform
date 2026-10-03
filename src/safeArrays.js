// Values crossing the API boundary must not be traversed with methods read
// from that value. A Proxy can present as an Array while replacing map/filter
// (or hiding accessors). This helper only reads own property descriptors and
// builds a fresh, ordinary array after it has proved the input is a plain,
// dense array of data properties.
const arrayIsArray = Array.isArray
const arrayPrototype = Array.prototype
const getPrototypeOf = Object.getPrototypeOf
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const ownKeys = Reflect.ownKeys
const hasOwn = Object.prototype.hasOwnProperty
const structuredCloneIntrinsic = globalThis.structuredClone

function isArrayIndexKey(key, index) {
  return key === String(index)
}

function isPlainDataDescriptor(descriptor) {
  return descriptor &&
    hasOwn.call(descriptor, "value") &&
    !hasOwn.call(descriptor, "get") &&
    !hasOwn.call(descriptor, "set") &&
    descriptor.enumerable === true &&
    descriptor.configurable === true &&
    descriptor.writable === true
}

// Returns a new array, never the caller-provided one. It intentionally
// accepts only JSON-shaped arrays (the format our HTTP APIs produce).
export function copyOrdinaryDenseArray(value, { maxLength = 100, isAllowed = () => true } = {}) {
  try {
    if (!arrayIsArray(value) || getPrototypeOf(value) !== arrayPrototype) return null

    const descriptors = getOwnPropertyDescriptors(value)
    const lengthDescriptor = descriptors.length
    if (
      !lengthDescriptor || !hasOwn.call(lengthDescriptor, "value") ||
      hasOwn.call(lengthDescriptor, "get") || hasOwn.call(lengthDescriptor, "set") ||
      lengthDescriptor.value < 0 || !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value > maxLength
    ) return null

    const length = lengthDescriptor.value
    const keys = ownKeys(descriptors)
    if (keys.length !== length + 1) return null

    const copy = new Array(length)
    for (let index = 0; index < length; index += 1) {
      const key = String(index)
      const descriptor = descriptors[key]
      if (!isArrayIndexKey(key, index) || !isPlainDataDescriptor(descriptor) || !isAllowed(descriptor.value)) return null
      copy[index] = descriptor.value
    }

    // The only permitted non-index own key is the native array length. This
    // rejects own map/filter methods, symbols, holes, and arbitrary extras.
    for (const key of keys) {
      if (key !== "length" && (typeof key !== "string" || !/^0$|^[1-9]\d*$/.test(key) || Number(key) >= length)) return null
    }

    // Proxies cannot be structured-cloned. Run this gate only after checking
    // descriptors, so an accessor can never execute while being inspected.
    if (typeof structuredCloneIntrinsic !== "function") return null
    structuredCloneIntrinsic(value)
    return copy
  } catch {
    return null
  }
}
