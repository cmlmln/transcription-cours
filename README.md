# Transcription de cours

Web app de transcription en direct d'un cours magistral en français, pensée pour l'iPad (Safari ou écran d'accueil). Aucun son n'est jamais enregistré ni stocké : seule l'API de reconnaissance vocale du navigateur est utilisée, et elle ne livre que du texte.

HTML/CSS/JS vanilla, aucune dépendance, aucun build, aucun CDN. Une politique CSP (`default-src 'self'`) empêche la page de contacter un autre serveur que le sien.

## Mise en ligne sur GitHub Pages (pas à pas)

1. Sur GitHub, ouvrez le dépôt › **Settings** › **Pages**.
2. *Source* : **Deploy from a branch**. *Branch* : `main`, dossier `/ (root)`. **Save**.
3. Attendez une à deux minutes : l'adresse `https://<utilisateur>.github.io/<dépôt>/` s'affiche en haut de la page. Elle est en HTTPS, ce qu'exige le micro.
4. À chaque mise à jour : incrémentez `VERSION` dans `js/version.js` **et** dans `sw.js` (un test vérifie qu'elles sont identiques), puis faites un commit et un push. L'iPad récupère la nouvelle version au prochain chargement avec réseau.

## Installer sur l'écran d'accueil de l'iPad

1. Ouvrez l'adresse dans **Safari** (pas dans Chrome iOS).
2. Bouton **Partager** › **Sur l'écran d'accueil** › **Ajouter**.
3. Lancez l'app depuis l'icône, touchez **Démarrer** et acceptez l'accès au micro.
4. Si la reconnaissance ne démarre pas en mode écran d'accueil (voir *Limites*), utilisez l'app dans un onglet Safari : tout fonctionne de la même façon, et les sessions sont partagées.

## Réglages iPad recommandés

- **Réglages › Luminosité et affichage › Verrouillage automatique : Jamais**. Ceinture et bretelles, même si l'app demande au système de garder l'écran allumé (Wake Lock).
- **Mode Ne pas déranger** (Centre de contrôle) : un appel ou une notification peut couper le micro.
- **Réglages › Safari › Microphone : Autoriser**.
- **Réglages › Général › Clavier › Activer la dictée** : la reconnaissance vocale de Safari en dépend (sinon erreur `service-not-allowed`).
- iPad branché ou bien chargé : 2 h 30 de micro avec l'écran allumé consomment beaucoup.
- Internet obligatoire : la reconnaissance de Safari passe par les serveurs d'Apple. Si le wifi de l'amphi est instable, un partage de connexion depuis un téléphone est plus sûr.

## Utilisation

- **Démarrer / Pause / Arrêter**. *Arrêter* clôt la session ; la session suivante repart à zéro.
- La pastille en haut indique l'état : **vert** = en écoute, **orange** = relance en cours (ou orange clignotant si aucun texte depuis 30 s), **rouge** = arrêté ou problème, avec la cause dans un bandeau.
- Si vous remontez dans le texte, le défilement automatique se met en pause. Le bouton **↓ Revenir au direct** le relance.
- **Modifier** (hors écoute) : corrigez le texte directement. Le texte brut d'origine est conservé.
- **Réglages** : glossaire de corrections (`en tropie → entropie`), mode continu, délai du chien de garde.
- **Exporter** : copier, `.txt`, `.md`, partager (Notes, Fichiers, AirDrop…), ou « texte nu » sans horodatage, pour une IA.
- **Historique** : rouvrir, renommer, exporter ou supprimer une session (la suppression demande confirmation).
- Si l'app est fermée en pleine session (crash, rechargement), elle propose au lancement suivant **« Reprendre la session de 10 h 14 »**.

## Procédure de test avant le premier vrai cours

1. **Démo sans micro** : ouvrez `…/?mock=1`. Un faux moteur simule un cours avec des pannes aléatoires. Vérifiez la pastille, les relances et l'export.
2. **Test 30 s** (Diagnostic › Test 30 s) dans Safari, puis depuis l'écran d'accueil. Les deux doivent afficher « ✓ Tout fonctionne », avec un wake lock actif.
3. **Test de 2 h**, dans les conditions réelles : même iPad, même mode (onglet ou écran d'accueil), réglages ci-dessus, branché ou non comme en cours. Faites tourner une vidéo de cours ou un podcast en français à volume normal, à 1–2 m de l'iPad.
   - Toutes les 30 min environ : la pastille est-elle verte, le texte avance-t-il ?
   - Pendant le test : passez 10 s sur une autre app puis revenez. Un repère « coupure » doit apparaître et l'écoute doit reprendre seule.
   - Coupez le wifi 30 s puis rallumez : le bandeau « Hors ligne » doit apparaître puis disparaître, et l'écoute doit reprendre.
   - À la fin : **Diagnostic › Copier le journal**, et regardez le nombre de relances, les erreurs et la durée des instances.
4. Si quelque chose cloche, envoyez le journal copié : il contient les transitions, les erreurs et la durée de chaque instance.

## Développement

```bash
npm test                      # tests unitaires + endurance 2 h 30 simulées (Node ≥ 20, aucune dépendance)
SEEDS=300 npm test            # endurance sur 300 graines aléatoires
python3 -m http.server 8000   # puis http://localhost:8000/?mock=1
```

Structure :

- `js/supervisor.js` : `RecognitionSupervisor`, le cœur du projet. Il gère la machine à états, le chien de garde, le backoff, la recréation d'instance à chaque relance, la promotion de l'intermédiaire en final et la déduplication. La fabrique d'instance et l'horloge sont injectées.
- `js/mock.js` : `MockRecognition` et `MockWorld`, un faux moteur qui produit des pannes aléatoires et reproduit le bug « onend absent ».
- `js/storage.js` : IndexedDB et localStorage en miroir, lecture fusionnée, reprise après crash.
- `js/export.js` : formats d'export, glossaire, nettoyage, repères horaires.
- `js/wakelock.js` : Wake Lock, avec en option une vidéo muette expérimentale.
- `js/ui.js` : interface.
- `sw.js` : cache du shell (index en network-first).
- `tests/` : tests `node:test`, avec une horloge factice.

## Limites connues

- **Internet obligatoire** : sans réseau, Safari ne transcrit rien. L'app relance seule au retour du réseau, mais ce qui a été dit pendant la coupure est perdu.
- **Trous entre relances** : sur iPad, la reconnaissance s'arrête après chaque phrase et l'app la relance aussitôt. Quelques mots prononcés pendant ce court intervalle (~0,2–0,5 s) peuvent manquer. Le mode continu réduit le nombre de relances, mais il est réputé moins stable sur iOS : comparez les deux dans Réglages.
- **Arrière-plan** : iOS coupe le micro dès que l'app n'est plus au premier plan. L'app le signale et reprend au retour, mais le passage est perdu.
- **Relance automatique refusée** : si iOS refuse une relance automatique (`not-allowed`), l'app s'arrête et demande un tap sur Démarrer. Le texte est conservé.
- **Mode écran d'accueil** : selon la version d'iPadOS, la reconnaissance vocale ou le Wake Lock peuvent y être absents ou instables (le Wake Lock en mode écran d'accueil n'est fiable qu'à partir d'iPadOS 18.4, d'après le suivi de bugs WebKit). Le panneau Diagnostic indique ce qui est disponible.
- **Ponctuation** : Safari en français en ajoute peu. Le nettoyage à l'export capitalise après les points existants, mais n'en invente pas.
- **Téléchargement en mode écran d'accueil** : préférez *Partager* ou *Copier*.
- **Stockage** : sans « stockage persistant » accordé, iOS peut effacer les données d'un site peu utilisé. Exportez après chaque cours.
- **Non testé sur un vrai iPad par l'auteur** : la logique est couverte par des tests automatisés (dont 2 h 30 simulées avec pannes aléatoires) et l'interface a été vérifiée dans Chrome en taille iPad. Le comportement réel de Safari iPadOS reste à valider avec la procédure ci-dessus.
