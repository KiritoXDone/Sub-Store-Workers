// Durable Object events may interleave across awaits; serialize the full user operation.
export function createUserRequestQueue() {
    let tail = Promise.resolve();
    return (handler) => {
        const result = tail.then(handler);
        tail = result.then(() => undefined, () => undefined);
        return result;
    };
}
