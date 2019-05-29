#!/usr/bin/env node

require('colors')
require('left-pad')

const emoji = require('node-emoji')
const rightpad = require('right-pad')
const request = require('request-promise-native')
const path = require('path')
const jsonpath = require('jsonpath')
const URL = require('url')
const program = require('commander')

const abort = (message) => {
    console.error(message)
    process.exit(1)
}

function collect(value, sum) {
    sum.push(value)
    return sum
}

program.name('ducttape')
    .version(require('./package.json').version)
    .usage('WORKSPACE [environment]')
    .option('-d, --debug', 'Show debug messages (implies --verbose)')
    .option('-v, --verbose', 'Show request/response bodies')
    .option('-r, --request [name-or-id]', 'Run a specific request (repeat for multiple).', collect, [])
    .option('-g, --group [name-or-id]', 'Run requests in a specific group (repeat for multiple).', collect, [])

program.parse(process.argv)

if (program.args.length < 1) {
    program.outputHelp()
    process.exit(1)
}

if (program.debug) {
    program.verbose = true
}

const workspaceFilePath = program.args[0]
var environmentName = program.args[1]
const requestNamesOrIds = program.request ? (program.request.length > 0 ? program.request : undefined) : undefined
const groupNamesOrIds = program.group ? (program.group.length > 0 ? program.group : undefined) : undefined

// Don't use proxy for localhost.
process.env['NO_PROXY'] = 'localhost'

const fs = require('fs')
const workspace = JSON.parse(fs.readFileSync(workspaceFilePath).toString('utf8'))

if (workspace._type !== "export" || workspace.__export_format != 3 || !workspace.resources) {
    abort("not an Insomnia v3 workspace")
}

var requestCount = 0
var successCount = 0
let allRequests = []
let allResources = []
let allRequestsUnfiltered = []
let topLevelExecutionOrder = []

// Figure out workspace ID first, before anything that depends on it, since workspace
// may be ordered after those things in the workspace file.
for (var i = 0; i < workspace.resources.length; i++) {
    let resource = workspace.resources[i]
    if (resource._type === 'workspace') {
        var workspaceName = resource.name
        var workspaceId = resource._id
    }
}

var baseEnvironment
for (var i = 0; i < workspace.resources.length; i++) {
    let resource = workspace.resources[i]
    if (resource._type === 'environment') {
        if (resource.parentId === workspaceId) {
            baseEnvironment = resource
        } else {
            if (environmentName) {
                if (resource.name === environmentName && !environment) {
                    var environment = resource
                }
            } else {
                if (!environment && resource.data && Object.keys(resource.data).length > 0) {
                    var environment = resource
                    environmentName = environment.name
                }
            }
        }
    }
}
if (baseEnvironment) {
    if (!environment) {
        environment = baseEnvironment
    } else {
        let mergedData = {}
        if (baseEnvironment.data) {
            Object.keys(baseEnvironment.data).forEach(key => {
                mergedData[key] = baseEnvironment.data[key]
            })
        }
        if (environment.data) {
            Object.keys(environment.data).forEach(key => {
                mergedData[key] = environment.data[key]
            })
        }
        environment.data = mergedData
    }
}

for (var i = 0; i < workspace.resources.length; i++) {
    let resource = workspace.resources[i]
    if (resource._type === 'request') {
        if (!isRequestFiltered(resource)) {
            allRequests.push(resource)
        }
        allRequestsUnfiltered.push(resource)

        if (resource.parentId === workspaceId && !isRequestFiltered(resource)) {
            topLevelExecutionOrder.push(resource)
        }
        allResources.push(resource)
    } else if (resource._type === 'request_group') {
        if (resource.parentId === workspaceId) {
            topLevelExecutionOrder.push(resource)
        }
        allResources.push(resource)
    }
}

var allRequestsById = allRequests.reduce((dict, req) => { dict[req._id] = req; return dict; }, {})
var allResourcesByGroupId = allResources.reduce((dict, r) => {
    dict[r.parentId] = dict[r.parentId] || []
    dict[r.parentId].push(r)
    return dict;
}, {})
let allRequestsByIdUnfiltered = allRequestsUnfiltered.reduce((dict, req) => { dict[req._id] = req; return dict; }, {})
var allResponsesByRequestId = {}

topLevelExecutionOrder.sort(workspaceSort)

if (!workspaceName) {
    abort("no 'workspace' resource found")
}
if (!environment) {
    if (!environmentName) {
        abort("unable to automatically detect which environment to use, specify it after the workspace file name.")
    } else {
        abort("environment '" + environmentName + "' does not exist")
    }
}
if (!allRequests.length || allRequests.length == 0) {
    abort("no requests found in workspace")
}

function isResourceFiltered(resource, namesOrIds) {
    if (namesOrIds && namesOrIds.length > 0) {
        for (var i = 0; i < namesOrIds.length; i++) {
            let pattern = namesOrIds[i].toLowerCase()
            let filtered
            if (pattern[0] === '/' && pattern[pattern.length - 1] === '/') {
                let re = new RegExp(pattern.substring(1, pattern.length - 1), "i")
                filtered = !!!resource.name.match(re)
            } else {
                filtered = pattern !== resource.name.toLowerCase() && pattern !== resource._id.toLowerCase()
            }
            return filtered
        }
        return true
    }
    return false
}

function isRequestFiltered(request) {
    return isResourceFiltered(request, requestNamesOrIds)
}

function isGroupFiltered(group) {
    let groupFiltered = isResourceFiltered(group, groupNamesOrIds)
    let children = allResourcesByGroupId[group._id]
    if (children && children.length > 0) {
        for (var i = 0; i < children.length; i++) {
            let child = children[i]
            if (child._type == 'request_group') {
                if (!isGroupFiltered(child)) {
                    // If any children not filtered, unfilter this group.
                    // TODO: ignore any requests directly on the containing (filtered) group,
                    // right now they would still be executed.
                    return false
                }
            }
        }
    }
    return groupFiltered
}

function logDebug(message) {
    if (program.debug) {
        console.log((" -- " + message).white.dim)
    }
}

function expandEnvironmentVariables(value, environment) {
    if (!environment || !environment.data) {
        return value
    }
    if (typeof value === 'undefined') {
        return value
    }
    Object.keys(environment.data).forEach(key => {
        var variable = environment.data[key]
        value = value.replace(new RegExp("\\{\\{\\s*" + key + "\\s*\\}\\}", "g"), variable)
    })
    return value
}

function minify(json) {
    return JSON.stringify(JSON.parse(json))
}

function expandJSONPathExpressions(value, environment) {
    // Support chained response body values.
    // They are of this format: {% response 'body', 'req_35901a749b594ec78de6d2f0e7944f1a', '$.id' %}
    const chainRegex = /\{\%\s*response\s*'body'\s*,\s*'([a-zA-Z0-9_]+)'\s*,\s*'([^']*)'\s*\%\}/gmi
    var currentValue = value
    var match
    var wasMatched = false
    while (match = chainRegex.exec(value)) {
        var requestId = match[1]
        var path = match[2]

        if (requestId) {
            let chainedResponse = allResponsesByRequestId[requestId]
            if (chainedResponse) {
                let responseObject = JSON.parse(chainedResponse.body)

                // HACK: If JSON path starts with '$..[', but the object is not an array, wrap it in an array.
                //       This lets us check whether an object has a field matching a value in JSON path without
                //       writing endpoint specific code that knows about the JSON.
                //
                //       Example: $..[?(@.status=="COMPLETED")].id
                //       Used on an endpoint that returns an object, and not an array.
                if (path.startsWith('$..[') && !Array.isArray(responseObject)) {
                    logDebug("assuming response should be wrapped in array before JSON path query execution")
                    responseObject = [responseObject]
                }

                if (program.debug) {
                    logDebug("executing JSON path '" + path + "' on object " + minify(JSON.stringify(responseObject)))
                }

                let chainedValue = jsonpath.query(responseObject, path)[0]
                if (typeof (chainedValue) !== 'undefined') {
                    currentValue = currentValue.replace(match[0], chainedValue)
                    wasMatched = true
                    continue
                } else {
                    logDebug("no match for request '" + requestId + " for path '" + path + "'")
                }
            }
        }

        // Fall-through, just replace with empty string.
        currentValue = currentValue.replace(match[0], "")
    }

    return {
        expandedValue: currentValue,
        wasMatched: wasMatched,
        requestId: requestId,
        path: path
    }
}

function headerLine(request, url, isPending, isError) {
    let shortUrl
    if (typeof url === 'undefined' || url == '') {
        shortUrl = '<undefined>'
    } else {
        const parsedUrl = URL.parse(url)
        if (parsedUrl) {
            shortUrl = parsedUrl.pathname
            if (parsedUrl.search) {
                shortUrl += parsedUrl.search
            }
            if (parsedUrl.hash) {
                shortUrl += parsedUrl.hash
            }
        } else {
            shortUrl = url
        }
    }
    const paddedMethod = rightpad(request.method, 7, ' ')
    const method = (isPending ? paddedMethod.blue.bold : (isError ? paddedMethod.red.bold : paddedMethod.green))
    const summary = method + " " + shortUrl.bold + (" (" + request.name + ")").white.dim
    const line = isPending ? "%s " + summary : (isError ? (":x:  " + summary) : (":white_check_mark:  " + summary))
    return emoji.emojify(line)
}

function handleRequestExceptionAndAbort(req, url, error) {
    console.log("")
    console.log(headerLine(req, url, false, true))
    if (error) {
        if (error.error && error.error.stack) {
            console.log(error.error.stack.bold.red)
        } else {
            console.log(error.toString().bold.red)
        }
    }
    // Type of error is usually connection refused, not HTTP errors, so bail out.
    process.exit(1)
}

function workspaceSort(a, b) {
    return a.metaSortKey < b.metaSortKey ? -1 : 1
}

function executeRequest(req, environment, chain, groupName, is_retry) {
    requestCount += 1
    if (!groupNameLogged) {
        console.log(("\n** group: " + groupName + "\n").bold)
        groupNameLogged = true
    }

    const expandedUrl = expandEnvironmentVariables(req.url, environment)
    let results = expandJSONPathExpressions(expandedUrl, environment)
    var url = expandedUrl

    if (typeof url === 'undefined' || url == '') {
        handleRequestExceptionAndAbort(req, undefined, new Error(`No URL set for request '${req.name}'`))
    }

    if (results.requestId && results.path && !results.wasMatched) {
        // to support cases where we want to "wait" for a response to have a particular value (e.g. async task),
        // we will trigger the chained request again.
        let chainedRequest = allRequestsById[results.requestId]
        if (chainedRequest) {
            //console.log("JSON path '" + results.path + "' did not match in URL, executing prior request '" + chainedRequest.name + "' again.")
            return chain.then(() => {
                return executeRequest(chainedRequest, environment, chain, groupName, true).then(() => {
                    return executeRequest(req, environment, chain)
                })
            })
        } else {
            let chainedRequest = allRequestsByIdUnfiltered[results.requestId]
            handleRequestExceptionAndAbort(
                req,
                url,
                new Error("request '" + req.name + "' depends on request '" + (chainedRequest ? chainedRequest.name : results.requestId) + "', but it was not found, or has not executed yet."))
        }
    } else if (results.wasMatched) {
        url = results.expandedValue
    }

    const mimeType = req.body ? req.body.mimeType : null
    const options = {
        method: req.method,
        uri: url,
        resolveWithFullResponse: true,
        simple: false,
        headers: {}
    }

    if (mimeType) {
        options.headers['Content-Type'] = mimeType

        // Support file uploads
        if (mimeType === 'multipart/form-data' && req.body.params) {
            var formData = {}
            for (var i = 0; i < req.body.params.length; i++) {
                const param = req.body.params[i]
                if (param.type && param.type === 'file' && param.fileName) {
                    formData[param.name] = {
                        value: fs.createReadStream(param.fileName),
                        options: {
                            filename: path.basename(param.fileName)
                        }
                    }
                }
            }
            if (formData) {
                options.formData = formData
            }
        }
    }

    logDebug(`request: ${req.method} ${url}`)
    logDebug(`headers: ${JSON.stringify(options.headers)}`)

    if (req.body && req.body.text) {
        let expandedBodyText = expandEnvironmentVariables(req.body.text, environment)
        let results = expandJSONPathExpressions(expandedBodyText, environment)
        if (results.requestId && results.path && !results.wasMatched) {
            let chainedRequest = allRequestsById[results.requestId]
            if (chainedRequest) {
                // to support cases where we want to "wait" for a response to have a particular value (e.g. async task),
                // we will trigger the chained request again.
                // console.log("JSON path '" + results.path + "' did not match in body, executing prior request '" + chainedRequest.name + "' again.")
                return chain.then(() => {
                    return executeRequest(chainedRequest, environment, chain, groupName, true).then(() => {
                        return executeRequest(req, environment, chain, groupName)
                    })
                })
            }
        } else {
            options.body = results.expandedValue
        }
    }

    return request(options)
        .then((response) => {
            const responseMimeType = response.headers['content-type']
            const responseLength = response.headers['content-length']
            const isJSONResponse = responseMimeType === 'application/json'
            const isTextResponse = responseMimeType.startsWith('text/')
            const loggableResponseBody = isJSONResponse
                ? minify(response.body).white.dim
                : (isTextResponse ? response.body.replace(/\r?\n|\n/g, '').white.dim : ("(" + responseLength + " byte(s))").white.dim)
            const isJSONRequest = mimeType === 'application/json'
            const isTextRequest = mimeType && mimeType.startsWith('text/')
            const loggableRequestBody = options.body && isJSONRequest
                ? minify(options.body)
                : (isTextRequest ? options.body.replace(/\r?\n|\n/g, '') : "(" + responseLength + " byte(s))")

            allResponsesByRequestId[req._id] = response

            let statusDetails = (program.verbose ? " " + response.statusMessage : " " + response.statusMessage)
            if (response.statusCode >= 200 && response.statusCode <= 299) {
                successCount += 1

                if (!!!is_retry) {
                    console.log("")
                    console.log(headerLine(req, url, false, false))
                    if (options.body && program.verbose) {
                        console.log(("           " + loggableRequestBody).white.dim)
                    }
                    console.log("    " + rightpad(response.statusCode.toString().green + statusDetails.green, 25, ' ') +
                        (program.verbose ? "\n           " + loggableResponseBody : ""))
                }
            } else {
                console.log("")
                console.log(headerLine(req, url, false, true))
                if (options.body && program.verbose) {
                    console.log(("           " + loggableRequestBody).white.dim)
                }
                console.log("    " + rightpad(response.statusCode.toString().red.bold + statusDetails.red, 25, ' ') +
                    (program.verbose ? "\n           " + loggableResponseBody : ""))
            }
        })
        .catch((error) => {
            handleRequestExceptionAndAbort(req, url, error)
        })
}

function executeAllResources(resources, environment, groupName) {
    return resources.reduce((chain, resource) => {
        return chain.then(() => {
            return executeResource(resource, environment, chain, groupName)
        })
    }, Promise.resolve())
}

var groupNameLogged = false

function executeResource(resource, environment, chain, groupName) {
    if (resource._type === 'request_group') {
        if (!isGroupFiltered(resource)) {
            let resources = allResourcesByGroupId[resource._id]
            resources = resources.filter(r => !isRequestFiltered(r) || !isGroupFiltered(r))
            resources.sort(workspaceSort)
            if (resources.length && resources.length > 0) {
                groupNameLogged = false
                return executeAllResources(resources, environment, resource.name, false)
            } else {
                return Promise.resolve()
            }
        } else {
            return Promise.resolve()
        }
    } else {
        if (!isRequestFiltered(resource)) {
            return executeRequest(resource, environment, chain, groupName)
        } else {
            return Promise.resolve()
        }
    }
}

console.log(("** workspace: '" + workspaceName + "'").bold)
console.log(("** environment: '" + environmentName + "'").bold)
Object.keys(environment.data).forEach(variable => {
    console.log(`     ${variable.green}: ${environment.data[variable].blue.bold}`)
})
console.log("")

executeAllResources(topLevelExecutionOrder, environment)
    .then(() => {
        console.log("")
        let prefix
        let succ
        let reqs
        let fail
        if (requestCount === successCount) {
            succ = successCount.toString().green
            reqs = requestCount.toString().green
            fail = (0).toString().green
            prefix = ":white_check_mark:"
        } else {
            succ = successCount === 0 ? successCount.toString().red : successCount.toString().green
            reqs = successCount === 0 ? requestCount.toString().red : requestCount.toString().yellow
            fail = (requestCount - successCount).toString().red
            prefix = ":x:"
        }
        console.log(emoji.emojify(`${prefix} all done (${reqs} request(s), ${succ} successful, ${fail} failed)`))
    })
