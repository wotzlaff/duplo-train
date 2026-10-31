from androguard.core.apk import APK
from androguard.core.dex import DEX
import os

a = APK('/home/nico/duplo/external/com-lego-duplo-train-4922-61757855-0a6386dfd5ea152b4e5499a6bedc7f29.apk')
d = DEX(a.get_dex())

out_dir = '/tmp/opencode/apk/smali_out'
os.makedirs(out_dir, exist_ok=True)

target_prefixes = ('Ldk/lego/cubb/bluetooth', 'Ldk/lego/cubb/model', 'Ldk/lego/cubb/unity', 'Ldk/lego/cubb/utils')

for cl in d.get_classes():
    cname = cl.get_name()
    if not cname.startswith(target_prefixes):
        continue
    safe = cname[1:-1].replace('/', '__').replace('$', '$$')
    lines = []
    for m in cl.get_methods():
        lines.append('')
        lines.append('### METHOD %s %s'%(m.get_name(), m.get_descriptor()))
        code = m.get_code()
        if not code:
            lines.append('   (abstract/native)')
            continue
        try:
            insts = list(code.get_bc().get_instructions())
        except Exception as e:
            lines.append('   (decode error %s)' % e)
            continue
        for i, inst in insts and enumerate(insts):
            try:
                # try to resolve reference constants
                raw = inst.get_output().strip()
                lines.append('  %s' % raw.replace('0x0', '0x', 0))
            except Exception as e:
                lines.append('  <err %s>' % e)
    with open(os.path.join(out_dir, safe.lstrip('L') + '.txt'), 'w') as f:
        f.write('\n'.join(lines))

print('dumped to', out_dir)
print('\n'.join(sorted(os.listdir(out_dir))))
