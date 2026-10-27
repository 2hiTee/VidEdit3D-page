#!/usr/bin/env python3
"""Build the website's real video assets from a verified arXiv demo manifest.

Usage: python scripts/build_media.py --demo-root /path/to/paper/demo
Requires ffmpeg and ffprobe. Camera paths and image content stay unchanged;
Fangzhou clips play at half speed, with synchronized source and edited views.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import re

ORIGINAL_COMPARISONS = ('garden_novase', 'person_hat2', 'dog_bandana_blue',
                        'room_red_armchair', 'bicycle_orange_frame', 'face_goldchain_ai')
COMPARISONS = ORIGINAL_COMPARISONS + ('face_beard', 'garden_gold', 'face_glasses',
                                    'face_headset', 'room_home', 'face_zombie_supp',
                                    'garden_white', 'person_mask')
SHORT_LABELS = {'bonsai_cyan_pot': 'Cyan planter', 'horse_saddle': 'Blue saddle blanket', 'fangzhou_elf': 'Elf ears and green eyes', 'fangzhou_eyes_remote': 'Larger eyes', 'fangzhou_nose_remote': 'Aquiline nose', 'face_reference_sunglasses_ppt': 'Reference glasses', 'garden_novase': 'Remove the vase', 'person_hat2': 'Red hat', 'dog_bandana_blue': 'Red bandana', 'room_red_armchair': 'Red armchair', 'bicycle_orange_frame': 'Orange-red bicycle frame', 'face_beard': 'Full beard', 'garden_gold': 'Gold vase', 'face_glasses': 'Black-framed glasses', 'face_headset': 'Over-ear headphones', 'room_home': 'HOME embroidery', 'face_zombie_supp': 'Zombie skin', 'garden_white': 'White leaves', 'person_mask': 'Black face mask', 'face_goldchain_ai': 'Golden chain'}
EXCLUDED_BODY = {'person_black_shirt', 'stump_clock_full', 'bear_glasses', 'person_cap_mask_ppt', 'face_cvpr', 'person_cvpr', 'person_suit_ppt', 'face_bald_tgr'}


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def probe(path):
    data = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]))
    video = next(v for v in data['streams'] if v['codec_type'] == 'video')
    return {'width': video['width'], 'height': video['height'],
            'frames': int(video.get('nb_frames', 0)), 'fps': video['avg_frame_rate'],
            'duration': float(data['format']['duration']),
            'audio': any(v['codec_type'] == 'audio' for v in data['streams'])}


def encode(src, dst, options, frames, size, audio=False):
    dst.parent.mkdir(parents=True, exist_ok=True)
    audio_trim = ['-af', f'atrim=duration={frames / 30},asetpts=PTS-STARTPTS',
                  '-t', str(frames / 30)] if audio else []
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-threads', '2',
                    '-i', str(src), *options, *audio_trim, '-filter_threads', '1',
                    '-c:v', 'libx264', '-threads', '3', '-preset', 'slow',
                    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                    '-map_metadata', '-1', str(dst)], check=True)
    data = probe(dst)
    assert (data['width'], data['height'], data['frames'], data['fps']) == (*size, frames, '30/1'), (dst, data)
    assert data['audio'] == audio, (dst, data)
    assert abs(data['duration'] - frames / 30) < .002, (dst, data)
    subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-nostdin', '-threads', '2',
                    '-i', str(dst), '-f', 'null', '-'], check=True)
    return {'sha256': sha(dst), 'bytes': dst.stat().st_size, **data}


def poster(src, dst, frame, width):
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-threads', '2',
                    '-i', str(src), '-vf', f'select=eq(n\\,{frame}),scale={width}:-2',
                    '-frames:v', '1', '-q:v', '2', str(dst)], check=True)


def finalize_catalog(top, output):
    """Use genuine comparison posters and share byte-identical source media."""
    sources, posters = {}, {}
    for item in top['cases']:
        item['label'] = SHORT_LABELS[item['id']]
        item['provenance'].get('comparison', {}).pop('baseline_methods', None)
        if item.get('comparison'):
            poster(output.parent / item['comparison'], output.parent / item['comparisonPoster'], 15, 1280)
        for field, seen in [('source', sources), ('sourcePoster', posters)]:
            file = output.parent / item[field]
            digest = sha(file)
            if digest in seen and item[field] != seen[digest]:
                file.unlink()
                item[field] = seen[digest]
            else:
                seen[digest] = item[field]


def stamp_asset_urls(site_root):
    """Invalidate cached overview/demo media when rebuilding the page."""
    index = site_root / 'index.html'
    html = index.read_text()
    for asset in ('app.js', 'media/hero.jpg', 'media/hero.mp4', 'media/full-demo.mp4'):
        versioned = f'{asset}?v={sha(site_root / asset)[:12]}'
        html = re.sub(r'(?<=\")' + re.escape(asset) + r'(?:\?[^\"]*)?(?=\")',
                      lambda _: versioned, html)
    index.write_text(html)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--demo-root', type=Path, required=True)
    parser.add_argument('--jobs', type=int, default=3)
    args = parser.parse_args()
    root = args.demo_root.resolve()
    output = Path(__file__).resolve().parents[1] / 'media'
    output.mkdir(parents=True, exist_ok=True)
    source_manifest = root / 'manifest.json'
    manifest = json.loads(source_manifest.read_text())
    source_movie = root / manifest['output']['path']
    assert sha(source_movie) == manifest['output']['sha256']
    assert manifest['edition']['name'] == 'arxiv'
    sequences = manifest['sequences']
    assert len(sequences) == manifest['edition']['case_count'] and not EXCLUDED_BODY.intersection(sequences)
    assert manifest['mosaic']['expected_count'] == 22
    assert all(manifest['videos'][item['video']]['case'] not in {'stump_clock_full', 'person_black_shirt'} for item in manifest['mosaic']['items'])
    duration = manifest['output']['duration_seconds']
    frame_count = manifest['output']['frame_count']
    assert round(duration * 30) == frame_count
    records = manifest['videos']
    top = {'version': 1, 'title': manifest['title'],
           'hero': {'video': 'media/hero.mp4', 'poster': 'media/hero.jpg', 'duration': 5, 'loop': True},
           'fullDemo': {'video': 'media/full-demo.mp4', 'poster': 'media/hero.jpg', 'duration': duration},
           'cases': [],
           'provenance': {'source_manifest': 'demo/manifest.json', 'source_manifest_sha256': sha(source_manifest),
                          'source_demo_sha256': sha(source_movie),
                          'case_selection': f"All {len(sequences)} arXiv body cases; bear glasses and the hat-and-mask case appear only in the 22-case overview.",
                          'processing': 'Complete frames; proportional scaling and H.264 compression. Fangzhou source and edited clips play at half speed. No synthesized views, crops, or image edits.',
                          'category_source': 'Original scene identity from each manifest case ID.'}}
    starts = {}; cursor = 0
    for shot in manifest['timeline']:
        shot_duration = shot.get('duration', shot.get('frame_count', 0) / 30 / shot.get('speed', 1))
        if shot.get('sequence') in COMPARISONS:
            assert shot['type'] == 'comparison_page'
            starts[shot['sequence']] = (round(cursor * 30), shot['baseline_methods'])
        cursor += shot_duration
    assert abs(cursor - duration) < 1e-8 and len(starts) == 14
    tasks = []
    tasks.append(('full-demo', source_movie, output / 'full-demo.mp4',
                  ['-map', '0:v:0', '-map', '0:a:0', '-vf', 'scale=1280:720:flags=lanczos', '-crf', '27', '-maxrate', '900k', '-bufsize', '1800k', '-c:a', 'aac', '-b:a', '96k'],
                  frame_count, (1280, 720), True))
    tasks.append(('hero', source_movie, output / 'hero.mp4',
                  ['-map', '0:v:0', '-frames:v', '150', '-vf', 'scale=1440:810:flags=lanczos', '-an', '-crf', '25', '-maxrate', '2000k', '-bufsize', '4000k'],
                  150, (1440, 810), False))
    poster(source_movie, output / 'hero.jpg', 30, 1920)
    for case, seq in sequences.items():
        directory = output / 'cases' / case
        directory.mkdir(parents=True, exist_ok=True)
        prefix = f'media/cases/{case}'
        source, edited = (records[seq[r]] for r in ('source_rgb', 'edited_rgb'))
        assert source['camera_path_sha256'] == edited['camera_path_sha256']
        speed = manifest['edition'].get('case_playback_factors', {}).get(case, 1)
        frames = round(240 / speed)
        item = {'id': case, 'label': SHORT_LABELS[case], 'title': seq['prompt'], 'prompt': seq['prompt'],
                'category': case.split('_')[0], 'source': f'{prefix}/source.mp4',
                'ours': f'{prefix}/ours.mp4', 'poster': f'{prefix}/poster.jpg',
                'sourcePoster': f'{prefix}/source.jpg', 'duration': frames / 30, 'width': 768, 'height': 384,
                'provenance': {'source_video_sha256': source['sha256'], 'ours_video_sha256': edited['sha256'],
                               'camera_path_sha256': source['camera_path_sha256'], 'native_frame_count': 240,
                               'native_size': [1280, 640], 'playback_speed': speed,
                               'render_stage': edited['provenance']['stage']}}
        for role, record in [('source', source), ('ours', edited)]:
            path = root / record['path']
            assert sha(path) == record['sha256']
            assert (record['width'], record['height'], record['frame_count']) == (1280, 640, 240)
            tasks.append((f'{case}/{role}', path, directory / f'{role}.mp4',
                          ['-map', '0:v:0', '-frames:v', str(frames), '-vf',
                           f'setpts=(PTS-STARTPTS)/{speed},fps=30,scale=768:384:flags=lanczos',
                           '-an', '-crf', '23', '-maxrate', '800k', '-bufsize', '1600k'],
                          frames, (768, 384), False))
            poster(path, directory / ('source.jpg' if role == 'source' else 'poster.jpg'), 120, 768)
        if case in starts:
            start, methods = starts[case]
            item['comparison'] = f'{prefix}/comparison.mp4'
            item['comparisonPoster'] = f'{prefix}/comparison.jpg'
            item['provenance']['comparison'] = {'demo_start_frame': start, 'frame_count': 225,
                                                'duration': 7.5,
                                                'labels': 'Original generic Baseline labels retained.'}
            tasks.append((f'{case}/comparison', source_movie, directory / 'comparison.mp4',
                          ['-map', '0:v:0', '-vf', f'trim=start_frame={start}:end_frame={start+225},setpts=PTS-STARTPTS,scale=1280:720:flags=lanczos',
                           '-an', '-crf', ('23' if case in ORIGINAL_COMPARISONS else '25'),
                           '-maxrate', ('1600k' if case in ORIGINAL_COMPARISONS else '1300k'),
                           '-bufsize', ('3200k' if case in ORIGINAL_COMPARISONS else '2600k')],
                          225, (1280, 720), False))
        if seq.get('user_provided'):
            ref = seq['user_provided']; path = root / ref['path']
            assert sha(path) == ref['sha256']
            name = 'reference' + path.suffix.lower()
            shutil.copyfile(path, directory / name)
            item['reference'] = {'src': f'{prefix}/{name}', 'label': 'User provided', 'sha256': ref['sha256'],
                                 'provenance': 'Original user-provided image from the demo manifest; bytes unchanged.'}
        top['cases'].append(item)
    result = {}
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(encode, *task[1:]): task[0] for task in tasks}
        for future in as_completed(futures):
            key = futures[future]
            result[key] = future.result()
            print(f'{len(result)}/{len(tasks)} {key}: {result[key]["bytes"]} bytes', flush=True)
    top['hero']['media'] = result['hero']; top['fullDemo']['media'] = result['full-demo']
    assert result['full-demo']['bytes'] < 25_000_000
    assert result['hero']['bytes'] < 2_000_000
    for item in top['cases']:
        item['media'] = {role: result[f'{item["id"]}/{role}'] for role in ('source', 'ours')}
        if item.get('comparison'):item['media']['comparison'] = result[f'{item["id"]}/comparison']
    finalize_catalog(top, output)
    (output / 'cases.json').write_text(json.dumps(top, ensure_ascii=False, indent=2) + '\n')
    stamp_asset_urls(output.parent)
    total = sum(path.stat().st_size for path in output.rglob('*') if path.is_file())
    assert total < 150_000_000, total
    print(f'Complete: {len(top["cases"])} cases, {len(result)} videos, {total} total bytes', flush=True)


if __name__ == '__main__':main()
