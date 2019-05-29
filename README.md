# ducttape

This is a utility to run requests in an Insomnia workspace.

## Prerequisites

You need `node.js` and `npm` installed.

## Installing

Clone this repository, and then run this command:

```shell
$ npm install -g
```

You should see output like this:

```shell
/usr/local/bin/ducttape -> /usr/local/lib/node_modules/ducttape/index.js
+ ducttape@1.0.0
updated 1 package in 0.693s
```

## Running

You should have the command `ducttape` in your PATH.
Run it without any parameters to see the help.

## Examples

This runs **all** of the requests in the Insomnia workspace `my-workspace.json`, in the same order as they
appear in the UI.

```shell
 $ ducttape my-workspace.json
```

This runs the requests named _list items_ and _create item_ in the Insomnia workspace `my-workspace.json`.

```shell
$  ducttape my-workspace.json -r 'list items' -r 'create item'
```

Either the request name or a workspace ID can be specified.
