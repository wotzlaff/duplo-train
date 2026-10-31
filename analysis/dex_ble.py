from androguard.core.apk import APK
from androguard.core.dex import DEX

a = APK('/home/nico/duplo/external/com-lego-duplo-train-4922-61757855-0a6386dfd5ea152b4e5499a6bedc7f29.apk')
d = DEX(a.get_dex())

targets = {}
for cl in d.get_classes():
    for m in cl.get_methods():
        code = m.get_code()
        if not code:
            continue
        try:
            insts = list(code.get_bc().get_instructions())
        except Exception:
            continue
        for inst in insts:
            op = inst.get_output().strip()
            if 'bluetooth' in op.lower():
                key = m.get_class_name()
                item = f'{m.get_name()} {m.get_descriptor()}\n        {op}'
                targets.setdefault(key, set()).add(item)

for cls, ops in sorted(targets.items()):
    print('###', cls)
    for o in sorted(ops):
        print('    ', o)
