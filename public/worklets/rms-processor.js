/**
 * Computes the RMS (root-mean-square) volume of each incoming audio block
 * and posts it back to the main thread, used for silence detection.
 */
class RmsProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const channel = inputs[0]?.[0];

        if (channel && channel.length > 0) {
            let sumOfSquares = 0;

            for (let i = 0; i < channel.length; i++) {
                sumOfSquares += channel[i] * channel[i];
            }

            const rms = Math.sqrt(sumOfSquares / channel.length);
            this.port.postMessage({ rms });
        }

        return true;
    }
}

registerProcessor('rms-processor', RmsProcessor);
