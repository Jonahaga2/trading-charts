# Kokoro text-to-speech (free, runs offline): python3 tts_kokoro.py model.onnx voices.npz VOICE SPEED out.wav < text
import sys, soundfile as sf
from kokoro_onnx import Kokoro
model, voices, voice, speed, out = sys.argv[1:6]
k = Kokoro(model, voices)
samples, sr = k.create(sys.stdin.read(), voice=voice, speed=float(speed), lang="en-us")
sf.write(out, samples, sr)
