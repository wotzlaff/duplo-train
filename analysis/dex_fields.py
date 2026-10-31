from androguard.core.apk import APK
from androguard.core.dex import DEX

a = APK('/home/nico/duplo/external/com-lego-duplo-train-4922-61757855-0a6386dfd5ea152b4e5499a6bedc7f29.apk')
d = DEX(a.get_dex())

for cl in d.get_classes():
    cname = cl.get_name()
    if not cname.startswith('Ldk/lego'):
        continue
    for f in cl.get_fields():
        init_val = f.get_init_value()
        if init_val is not None:
            v = init_val.get_value()
            print(f'{cname} : {f.get_name()} = {v!r}')
