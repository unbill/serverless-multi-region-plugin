const path = require('path')
const _ = require('lodash')
const yaml = require('js-yaml')
const fs = require('fs')

class Plugin {
  constructor(serverless, options) {
    this.serverless = serverless
    this.options = options
    this.hooks = {
      'before:deploy:createDeploymentArtifacts': this.createDeploymentArtifacts.bind(this)
    }
  }

  createDeploymentArtifacts() {
    if (!this.serverless.service.custom.cdn) {
      this.serverless.service.custom.cdn = {}
    }

    if (!this.serverless.service.custom.dns) {
      this.serverless.service.custom.dns = {}
    }

    const disabled = this.serverless.service.custom.cdn.disabled
    if (disabled != undefined && disabled) {
      return
    }

    this.fullDomainName = this.serverless.service.custom.dns.domainName
    if (!this.fullDomainName) {
      this.serverless.cli.log('The domainName parameter is required')
      return
    }

    const hostSegments = this.fullDomainName.split('.')

    if (hostSegments.length < 3) {
      this.serverless.cli.log(`The domainName was not valid: ${this.fullDomainName}.`)
      return
    }

    this.hostName = `${hostSegments[hostSegments.length - 2]}.${
      hostSegments[hostSegments.length - 1]
    }`
    this.regionalDomainName = this.buildRegionalDomainName(hostSegments)

    const baseResources = this.serverless.service.provider.compiledCloudFormationTemplate

    const filename = path.resolve(__dirname, 'resources.yml') // eslint-disable-line
    const content = fs.readFileSync(filename, 'utf-8')
    const resources = yaml.safeLoad(content, {
      filename: filename
    })

    return this.prepareResources(resources).then(() => {
      this.serverless.cli.log(
        `The multi-regional-plugin completed resources: ${yaml.safeDump(resources)}`
      )
      _.merge(baseResources, resources)
    })
  }

  prepareResources(resources) {
    const credentials = this.serverless.providers.aws.getCredentials()
    const acmCredentials = Object.assign({}, credentials, { region: this.options.region })
    this.acm = new this.serverless.providers.aws.sdk.ACM(acmCredentials)

    const distributionConfig = resources.Resources.ApiDistribution.Properties.DistributionConfig
    const cloudFrontRegion = this.serverless.service.custom.cdn.region
    const enabled = this.serverless.service.custom.cdn.enabled
    let createCdn = true
    if (
      cloudFrontRegion !== this.options.region ||
      (enabled && !enabled.includes(this.options.stage))
    ) {
      createCdn = false
      delete resources.Resources.ApiGlobalEndpointRecord
      delete resources.Outputs.ApiDistribution
      delete resources.Outputs.GlobalEndpoint
    } else {
      this.prepareCdnComment(distributionConfig)
      this.prepareCdnOrigins(distributionConfig)
      this.prepareCdnHeaders(distributionConfig)
      this.prepareCdnPriceClass(distributionConfig)
      this.prepareCdnAliases(distributionConfig)
      this.prepareCdnLogging(distributionConfig)
      this.prepareCdnWaf(distributionConfig)
      this.prepareApiGlobalEndpointRecord(resources)
    }

    this.prepareApiRegionalBasePathMapping(resources)
    this.prepareApiRegionalEndpointRecord(resources)
    this.prepareApiRegionalHealthCheck(resources)

    return this.prepareApiRegionalDomainSettings(resources).then(() => {
      if (createCdn) {
        return this.prepareCdnCertificate(distributionConfig)
      } else {
        delete resources.Resources.ApiDistribution
      }
    })
  }

  buildRegionalDomainName(hostSegments) {
    let regionalDomainName = this.serverless.service.custom.dns.regionalDomainName
    if (!regionalDomainName) {
      const lastNonHostSegment = hostSegments[hostSegments.length - 3]
      hostSegments[hostSegments.length - 3] = `${lastNonHostSegment}-${this.options.stage}`
      regionalDomainName = hostSegments.join('.')
    }
    return regionalDomainName
  }

  prepareApiRegionalDomainSettings(resources) {
    const properties = resources.Resources.ApiRegionalDomainName.Properties

    properties.DomainName = this.regionalDomainName

    const regionSettings = this.serverless.service.custom.dns[this.options.region]
    if (regionSettings) {
      const acmCertificateArn = regionSettings.acmCertificateArn
      if (acmCertificateArn) {
        properties.RegionalCertificateArn = acmCertificateArn
        return Promise.resolve()
      }
    }

    return this.getCertArnFromHostName().then(certArn => {
      if (certArn) {
        properties.RegionalCertificateArn = certArn
      } else {
        delete properties.RegionalCertificateArn
      }
    })
  }

  prepareApiRegionalBasePathMapping(resources) {
    const apiStubProperties = resources.Resources.ApiGatewayStubDeployment.Properties
    apiStubProperties.StageName = this.options.stage

    const properties = resources.Resources.ApiRegionalBasePathMapping.Properties
    properties.Stage = this.options.stage
  }

  prepareApiRegionalEndpointRecord(resources) {
    const properties = resources.Resources.ApiRegionalEndpointRecord.Properties

    const hostedZoneId = this.serverless.service.custom.dns.hostedZoneId
    if (hostedZoneId) {
      delete properties.HostedZoneName
      properties.HostedZoneId = hostedZoneId
    } else {
      delete properties.HostedZoneId
      properties.HostedZoneName = `${this.hostName}.`
    }

    const regionSettings = this.serverless.service.custom.dns[this.options.region]
    if (regionSettings && regionSettings.failover) {
      properties.Failover = regionSettings.failover
    } else {
      properties.Region = this.options.region
    }

    properties.SetIdentifier = this.options.region

    const elements = resources.Outputs.RegionalEndpoint.Value['Fn::Join'][1]
    if (elements[2]) {
      elements[2] = `/${this.options.stage}`
    }
  }

  prepareApiRegionalHealthCheck(resources) {
    const dnsSettings = this.serverless.service.custom.dns
    const regionSettings = dnsSettings[this.options.region]

    const properties = resources.Resources.ApiRegionalEndpointRecord.Properties

    if (regionSettings && regionSettings.healthCheckId) {
      properties.HealthCheckId = regionSettings.healthCheckId
      delete resources.Resources.ApiRegionalHealthCheck
    } else {
      const healthCheckProperties = resources.Resources.ApiRegionalHealthCheck.Properties
      if (dnsSettings.healthCheckResourcePath) {
        healthCheckProperties.HealthCheckConfig.ResourcePath = dnsSettings.healthCheckResourcePath
      } else {
        healthCheckProperties.HealthCheckConfig.ResourcePath = `/${this.options.stage}/healthcheck`
      }
    }
  }

  prepareCdnComment(distributionConfig) {
    const name = this.serverless.getProvider('aws').naming.getApiGatewayName()
    distributionConfig.Comment = `API: ${name}`
  }

  prepareCdnOrigins(distributionConfig) {
    distributionConfig.Origins[0].DomainName = this.regionalDomainName
  }

  prepareCdnHeaders(distributionConfig) {
    const headers = this.serverless.service.custom.cdn.headers

    if (headers) {
      distributionConfig.DefaultCacheBehavior.ForwardedValues.Headers = headers
    } else {
      distributionConfig.DefaultCacheBehavior.ForwardedValues.Headers = ['Accept', 'Authorization']
    }
  }

  prepareCdnPriceClass(distributionConfig) {
    const priceClass = this.serverless.service.custom.cdn.priceClass

    if (priceClass) {
      distributionConfig.PriceClass = priceClass
    } else {
      distributionConfig.PriceClass = 'PriceClass_100'
    }
  }

  prepareCdnAliases(distributionConfig) {
    let aliases = this.serverless.service.custom.cdn.aliases

    if (aliases) {
      if (!aliases.length || aliases.length === 0) {
        delete distributionConfig.Aliases
      }
      distributionConfig.Aliases = aliases
    } else {
      aliases = [this.fullDomainName]
      distributionConfig.Aliases = aliases
    }
  }

  prepareCdnCertificate(distributionConfig) {
    const acmCertificateArn = this.serverless.service.custom.cdn.acmCertificateArn

    if (acmCertificateArn) {
      distributionConfig.ViewerCertificate.AcmCertificateArn = acmCertificateArn
      return Promise.resolve()
    } else {
      return this.getCertArnFromHostName().then(certArn => {
        if (certArn) {
          distributionConfig.ViewerCertificate.AcmCertificateArn = certArn
        } else {
          delete distributionConfig.ViewerCertificate
        }
      })
    }
  }

  prepareCdnLogging(distributionConfig) {
    const logging = this.serverless.service.custom.cdn.logging

    if (logging) {
      distributionConfig.Logging.Bucket = `${logging.bucketName}.s3.amazonaws.com`
      distributionConfig.Logging.Prefix =
        logging.prefix ||
        `aws-cloudfront/api/${this.options.stage}/${this.serverless
          .getProvider('aws')
          .naming.getStackName()}`
    } else {
      delete distributionConfig.Logging
    }
  }

  prepareCdnWaf(distributionConfig) {
    const webACLId = this.serverless.service.custom.cdn.webACLId

    if (webACLId) {
      distributionConfig.WebACLId = webACLId
    } else {
      delete distributionConfig.WebACLId
    }
  }

  prepareApiGlobalEndpointRecord(resources) {
    const properties = resources.Resources.ApiGlobalEndpointRecord.Properties

    const hostedZoneId = this.serverless.service.custom.dns.hostedZoneId
    if (hostedZoneId) {
      delete properties.HostedZoneName
      properties.HostedZoneId = hostedZoneId
    } else {
      delete properties.HostedZoneId
      properties.HostedZoneName = `${this.hostName}.`
    }

    properties.Name = `${this.fullDomainName}.`

    const elements = resources.Outputs.GlobalEndpoint.Value['Fn::Join'][1]
    if (elements[1]) {
      elements[1] = this.fullDomainName
    }
  }

  /*
   * Obtains the certification arn
   */
  getCertArnFromHostName() {
    const certRequest = this.acm
      .listCertificates({ CertificateStatuses: ['PENDING_VALIDATION', 'ISSUED', 'INACTIVE'] })
      .promise()

    return certRequest
      .then(data => {
        // The more specific name will be the longest
        let nameLength = 0
        let certArn
        const certificates = data.CertificateSummaryList

        // Derive certificate from domain name
        certificates.forEach(certificate => {
          let certificateListName = certificate.DomainName

          // Looks for wild card and takes it out when checking
          if (certificateListName[0] === '*') {
            certificateListName = certificateListName.substr(2)
          }

          // Looks to see if the name in the list is within the given domain
          // Also checks if the name is more specific than previous ones
          if (
            this.hostName.includes(certificateListName) &&
            certificateListName.length > nameLength
          ) {
            nameLength = certificateListName.length
            certArn = certificate.CertificateArn
          }
        })
        if (certArn) {
          this.serverless.cli.log(
            `The host name ${this.hostName} resolved to the following certificateArn: ${certArn}`
          )
        }
        return certArn
      })
      .catch(err => {
        throw Error(`Error: Could not list certificates in Certificate Manager.\n${err}`)
      })
  }
}

module.exports = Plugin
