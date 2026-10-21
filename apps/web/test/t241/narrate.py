"""Local Kokoro narration + relay-safe encoding. Run with ~/studio/.venv/bin/python."""
import os, pathlib, subprocess
import soundfile as sf
from kokoro_onnx import Kokoro
scratch = pathlib.Path(os.environ.get('TMPDIR', '/tmp')) / 't241'
output = pathlib.Path.home() / '.hermes/cache/scratch/t241/walkthrough-crypto.mp4'
output.parent.mkdir(parents=True, exist_ok=True)
model = pathlib.Path.home() / '.local/share/kokoro'
k = Kokoro(str(model / 'kokoro.onnx'), str(model / 'voices.bin'))
lines = [
  (5, 'The admin changes this synthetic crypto member from Cold Desk to the fifty dollar plan. The next invoice costs fifty dollars, while the original five hundred dollar invoice stays unchanged.'),
  (24, 'The admin applies SAVE20 to the existing crypto subscription. The next invoice records the code and twenty percent off, bringing the payment to forty dollars. Earlier invoices keep their prices.'),
  (41, 'This local fixture did not test live Supabase, Stripe redemption, wallet payments, or physical door locks.'),
]
inputs = ['-i', str(scratch / 'walkthrough.webm')]
filters = []
for index, (start, text) in enumerate(lines):
    samples, rate = k.create(text, voice='am_michael', speed=1.05, lang='en-us')
    wav = scratch / f'narration-{index}.wav'; sf.write(wav, samples, rate)
    inputs += ['-i', str(wav)]
    filters.append(f'[{index+1}:a]aresample=48000,adelay={start*1000}|{start*1000}[a{index}]')
filters.append('[a0][a1][a2]amix=inputs=3:normalize=0,apad,atrim=0:57[a]')
filters.append('[0:v]tpad=stop_mode=clone:stop_duration=10[v]')
subprocess.run(['ffmpeg','-y','-loglevel','error', *inputs, '-filter_complex',';'.join(filters), '-map','[v]','-map','[a]', '-t','57',
 '-map_metadata','-1','-map_chapters','-1','-fflags','+bitexact','-flags:v','+bitexact','-flags:a','+bitexact',
 '-metadata:s:v','handler_name=','-metadata:s:a','handler_name=', '-c:v','libx264','-x264-params','no-info=1','-pix_fmt','yuv420p','-crf','25',
 '-c:a','aac','-b:a','96k','-ac','1','-movflags','+faststart', str(output)], check=True)
subprocess.run(['ffprobe','-v','error','-show_entries','stream=codec_type,codec_name,width,height:format=duration,size','-of','json',str(output)],check=True)
assert output.stat().st_size < 8_000_000
