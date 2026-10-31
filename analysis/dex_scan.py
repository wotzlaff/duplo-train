from androguard.core.apk import APK
from androguard.core.dex import DEX

a = APK('/home/nico/duplo/external/com-lego-duplo-train-4922-61757855-0a6386dfd5ea152b4e5499a6bedc7f29.apk')
d = DEX(a.get_dex())

classes = sorted(set(cl.get_name() for cl in d.get_classes()))
skip_prefixes = (
    'Landroid/', 'Ljava/', 'Lkotlin', 'Lk/', 'Lorg/', 'Landroidx/',
    'Lcom/google/', 'Ljunit', 'Ljavax/', 'Lcom/unity', 'Lcom/a',
    'Lnet/daan', 'Lio/', 'Lcom/bumptech', 'Lcom/nostra13',
    'Lcom/vico', 'Lcom/caverock', 'Lcom/sk`,',
)
keep = []
for c in classes:
    if not c.startswith(skip_prefixes):
        keep.append(c)
print('non-framework classes:', len(keep))
for c in keep:
    print(c)
